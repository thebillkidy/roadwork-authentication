const Promise = require('bluebird');
const Boom = require('boom');
const dbUtil = require('./db/utils/dbUtil');
const pluralize = require('pluralize');

let instance = null;

class RoadworkAuthentication {
    constructor (server, bookshelf) {
        if (!instance) {
            instance = this;
        }

        if (!server) {
            throw new Error('Missing the http engine');
        }

        if (!bookshelf) {
            throw new Error('Missing the bookshelf object');
        }

        this.server = server;
        this.strategyName = 'roadwork-authentication-bearer';
        this.bookshelf = bookshelf;

        this.models = {};
        this.models.UserModel = require('./db/models/User')(this.bookshelf);
        this.models.UserSessionModel = require('./db/models/UserSession')(this.bookshelf);

        this.controllers = {};
        this.controllers.AuthController = require('./controllers/AuthController')(this.models);

        return instance;
    }

    /**
     * Registers the routes of a passed require() routes file to the engine
     * @param routesFile
     */
    addRoute (routesFile) {
        var self = this;
        console.log(routesFile);
        for (var route in routesFile) {
            console.info('[x] route: ' + routesFile[route].method + ' ' + routesFile[route].path);
            self.server.route(routesFile[route]);
        }
    }

    /**
     * Init the library, this will perform some checks, and also init some pre-existing functionality such as the login routes
     */
    init () {
        var self = this;

        console.log('===========================================');
        console.log('Initializing Roadwork Authentication Plugin');
        console.log('===========================================');
        console.log('Checking the required scheme');
        return self.checkRequiredScheme()
            .then(() => {
                console.log('Adding routes');
                // Add routes
                self.addRoute(require('./routes/auth')(self.controllers.AuthController));


                return Promise.resolve();
            })
            .catch((err) => {
                return Promise.reject(err);
            });
    }

    /**
     * Check if the required tables and columns exist in the database. These are:
     * user
     *     - id
     * user_session
     *     - user_id
     *     - token
     *
     * The non existent tables will be created by the system
     * @returns boolean
     */
    checkRequiredScheme () {
        // Create the user table if needed or if it has missing columns
        return this.bookshelf.knex.schema.hasTable('user')
            .then((exists) => {
                if (exists) {
                    console.info('[x] User table exists');
                    return this.checkUserTableScheme();
                }

                console.info('[x] Creating User table');
                return this.createUserTable();
            })
            // Create the user_session table if needed or if it has missing columns
            .then(() => {
                console.info('[x] User table required columns exist');
                return this.bookshelf.knex.schema.hasTable('user_session');
            })
            .then((exists) => {
                if (exists) {
                    console.info('[x] UserSession table exists');
                    return this.checkUserSessionScheme();
                }

                console.info('[x] Creating UserSession table');
                return this.createUserSessionTable();
            })
            .then(() => {
                console.info('[x] UserSession table required columns exist');
                return Promise.resolve();
            })
            .catch((err) => {
                return Promise.reject(err);
            });
    }

    checkUserTableScheme () {
        var tableName = 'user';
        var requiredColumns = [ 'id' ];

        return dbUtil.columnsExist(this.bookshelf.knex, tableName, requiredColumns);
    }

    checkUserSessionScheme () {
        var tableName = 'user_session';
        var requiredColumns = [ 'user_id', 'token' ];

        return dbUtil.columnsExist(this.bookshelf.knex, tableName, requiredColumns);
    }

    createUserTable () {
        return dbUtil.createTableByScheme(this.bookshelf.knex, require('./db/schemas/user'), 'user');
    }

    createUserSessionTable () {
        return dbUtil.createTableByScheme(this.bookshelf.knex, require('./db/schemas/user_session'), 'user_session');
    }

    /**
     * The validate function to be used to see if a user has access to a specific route
     * @param token
     * @param callback(err, isValid, credentials)
     */
    validateFunction (token, callback) {
        var self = this;

        this.models
            .UserSessionModel
            .where({ token: token })
            .fetch()
            .then(function (userSession) {
                if (!userSession) {
                    return Promise.reject(Boom.badRequest('INVALID_TOKEN'));
                }

                return self.models.UserModel.where({ id: userSession.get('user_id') }).fetch();
            })
            .then(function (user) {
                if (!user) {
                    return Promise.reject(Boom.badRequest('INVALID_TOKEN'));
                }

                var userObj = user;
                userObj.scope = [ user.get('scope') ];

                // Add the $owner role to the scope array, note that this is needed to get access to $owner rolesAllowed routes
                userObj.scope.push('$owner');
                // userObj.scope.push('user-' + userObj.id);

                return callback(null, true, userObj);
            })
            .catch(function (err) {
                return callback(err);
            });
    }

    hasAccessToRow (request, rolesAllowed, model) {
        var self = this;

        return new Promise((resolve, reject) => {
            let credentials = request.auth.credentials;

            if (!request.path || !request.path.split('/') || !request.path.split('/')[2]) {
                return resolve(false);
            }

            let rowId = request.path.split('/')[2];

            self.getTableRowOwner(model.tableName, rowId)
            .then((ownerId) => {
                if (credentials && parseInt(ownerId) === parseInt(credentials.get('id'))) {
                    return resolve(true);
                }

                return resolve(false);
            });
        });
    }

    getTableRowOwner (table, rowId) {
        // If it's the main user table, return the id
        if (table === 'user') {
            return Promise.resolve(rowId);
        } else {
            return new Promise((resolve, reject) => {
                this.bookshelf.knex.select('user_id').from(table).where('id', rowId)
                    .then((result) => {
                        if (!result || result.length == 0) {
                            return resolve(null);
                        }

                        return resolve(result[0].user_id);
                    });
            });
        }
    }

    /**
     * Create the implementation to be used in the hapi framework
     */
    getHapiFrameworkInterface () {
        return require('./adapters/hapi-interface')(this);
    }

    /**
     * Validates the headers and queryParams its access_token. This can be passed in the header through:
     * Authorization: Bearer <token>
     *
     * or in the query through:
     * ?access_token=<token>
     *
     * the rules of parsing: QueryParameters > Authorization Header
     *
     * @param headers
     * @param queryParams
     * @param callback(err, credentialsObject)
     * @returns {*}
     */
    validateBearerToken (headers, queryParams, callback) {
        var self = this;

        let bearerToken = '';

        if (queryParams.access_token) {
            bearerToken = queryParams.access_token;
            //delete queryParams.access_token;
        }
        else if (headers.authorization && headers.authorization !== undefined) {
            const headerParts = headers.authorization.split(' ');

            if (headerParts[0].toLowerCase() !== 'bearer') {
                return callback(Boom.unauthorized(null, this.strategyName));
            }

            bearerToken = headerParts[1];
        }
        else {
            return callback(Boom.unauthorized(null, this.strategyName));
        }

        return self.validateFunction(bearerToken, (err, isValid, credentials) => {
            //console.log(err);
            //console.log(isValid);
            //console.log(credentials);
            return self.validateCallback(err, isValid, credentials, bearerToken, callback);
        });
    }

    validateCallback (err, isValid, credentials, token, callback) {
        credentials = credentials || null;

        if (err) {
            return callback(err, credentials);
        }

        if (!isValid) {
            return callback(Boom.unauthorized(null, this.strategyName, {
                isValid,
                credentials
            }), credentials);
        }

        if (!credentials || typeof credentials !== 'object') {
            return callback(Boom.badImplementation('Bad credentials object received for bearerAuth auth validation'));
        }

        credentials.token = token;

        return callback(null, credentials);
    }
}

module.exports = RoadworkAuthentication;
