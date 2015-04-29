/* jshint node:true */
'use strict';
require('../util/panic');

var _ = require('lodash');
var Q = require('q');
var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');
var repl = require('repl');
var mkdirp = require('mkdirp');
var argv = require('minimist')(process.argv);
var Semaphore = require('noobaa-util/semaphore');
var api = require('../api');
var Agent = require('./agent');
var fs_utils = require('../util/fs_utils');
// var config = require('../../config.js');
var dbg = require('noobaa-util/debug_module')(__filename);
var child_process = require('child_process');

Q.longStackSupport = true;


/**
 *
 * AgentCLI
 *
 * runs multiple agents in same process and provides CLI to list/start/stop/create etc.
 *
 * but might also be relevant for other environments that want to combine multiple agents.
 * when running local testing where it's easier to run all the agents inside the same process.
 *
 */
function AgentCLI(params) {
    this.params = params;
    this.client = new api.Client();
    this.agents = {};
    // this._mod = dbg;
    // this.modules = this._mod.get_module_structure();
}


/**
 *
 * INIT
 *
 *
 *
 */
AgentCLI.prototype.init = function() {
    var self = this;

    return Q.nfcall(fs.readFile, 'agent_conf.json')
        .then(function(data) {
            var agent_conf = JSON.parse(data);
            dbg.log0('using agent_conf.json', util.inspect(agent_conf));
            self.params = _.defaults(self.params, agent_conf);
        })
        .then(null, function(err) {
            dbg.log0('cannot find configuration file. Using defaults.');
            self.params = _.defaults(self.params, {
                root_path: './agent_storage/',
                address: 'http://localhost:5001',
                port: 0,
                email: 'demo@noobaa.com',
                password: 'DeMo',
                system: 'demo',
                tier: 'nodes',
                bucket: 'files'
            });
        })
        .then(function() {
            self.client.options.address = self.params.address;

            if (self.params.setup) {
                dbg.log0('Setup');
                var account_params = _.pick(self.params, 'email', 'password');
                account_params.name = account_params.email;
                return self.client.account.create_account(account_params)
                    .then(function() {
                        dbg.log0('COMPLETED: setup', self.params);
                    }, function(err) {
                        dbg.log0('ERROR: setup', self.params, err.stack);
                    })
                    .then(function() {
                        process.exit();
                    });
            }
        }).then(function() {

            return self.load()
                .then(function() {
                    dbg.log0('COMPLETED: load');
                }, function(err) {
                    dbg.log0('ERROR: load', self.params, err.stack);
                    throw new Error(err);
                });
        });
};

try {
    setInterval(function() {
        dbg.log0(
            'memory ' + JSON.stringify(process.memoryUsage()));
    }, 30000);
} catch (ex) {
    dbg.log0("prob xxxxxxx");
}

AgentCLI.prototype.init.helper = function() {
    dbg.log0("Init client");
};

/**
 *
 * LOAD
 *
 * create account, system, tier, bucket.
 *
 */
AgentCLI.prototype.load = function() {
    var self = this;

    return Q.fcall(function() {
            return Q.nfcall(mkdirp, self.params.root_path);
        })
        .then(function() {
            return self.hide_storage_folder();
        })
        .then(null, function(err) {
            dbg.error('Windows - failed to hide', err.stack || err);
            // TODO really continue on error?
        })
        .then(function() {
            return Q.nfcall(fs.readdir, self.params.root_path);
        })
        .then(function(names) {
            return Q.all(_.map(names, function(node_name) {
                return self.start(node_name);
            }));
        })
        .then(function(res) {
            dbg.log0('loaded ', res.length, 'agents. show details with: list()');
            if (self.params.prod && !res.length) {
                return self.create();
            }
        })
        .then(null, function(err) {
            dbg.log0('load failed ' + err.stack);
            throw err;
        });
};

AgentCLI.prototype.hide_storage_folder = function() {
    var self = this;
    dbg.log0('os:', os.type());
    if (os.type().indexOf('Windows') >= 0) {
        var current_path = self.params.root_path;
        current_path = current_path.substring(0, current_path.length - 1);
        current_path = current_path.replace('./', '');

        //hiding storage folder
        return Q.nfcall(child_process.exec, 'attrib +H ' + current_path)
            .then(function() {
                //Setting system full permissions and remove builtin users permissions.
                //TODO: remove other users
                return Q.nfcall(child_process.exec,
                    'icacls ' + current_path +
                    ' /grant :r administrators:(oi)(ci)F' +
                    ' /grant :r system:F' +
                    ' /t' +
                    ' /remove:g BUILTIN\\Users' +
                    ' /inheritance:r');
            });
    }
};

AgentCLI.prototype.load.helper = function() {
    dbg.log0("create token, start nodes ");
};

/**
 *
 * CREATE
 *
 * create new node agent
 *
 */
AgentCLI.prototype.create = function() {
    var self = this;

    var node_name = os.hostname() + '-' + Date.now();
    var node_path = path.join(self.params.root_path, node_name);
    var token_path = path.join(node_path, 'token');
    dbg.log0('create new node');
    return fs_utils.file_must_not_exist(token_path)
        .then(function() {
            if (self.create_node_token) return;
            // authenticate and create a token for new nodes

            var auth_params = _.pick(self.params,
                'email', 'password', 'system', 'role');
            if (_.isEmpty(auth_params)) {
                if (_.isEmpty(self.params.noobaa_access_key)) {
                    dbg.log0('Exiting as there is no credential information.');

                    throw new Error("No credentials");

                } else {

                    var access_res = {
                        res: "Access Param",
                        token: self.params.noobaa_access_key
                    };
                    return access_res;
                }

            } else {
                if (self.params.tier) {
                    auth_params.extra = {
                        tier: self.params.tier
                    };
                }
                return self.client.create_auth_token(auth_params);
            }
        })
        .then(function(res) {
            if (res) {
                dbg.log0('result create:', res);
                self.create_node_token = res.token;
            } else {
                dbg.log0('has token', self.create_node_token);
            }
        })
        .then(function() {
            return Q.nfcall(mkdirp, node_path);
        }).then(function() {
            return Q.nfcall(fs.writeFile, token_path, self.create_node_token);
        })
        .then(function() {
            return self.start(node_name);
        }).then(function(res) {
            dbg.log0('created', node_name);
            return res;
        }, function(err) {
            dbg.log0('create failed', node_name, err, err.stack);
            throw err;
        });
};

AgentCLI.prototype.create.helper = function() {
    dbg.log0("Create a new agent and start it");
};

/**
 *
 * CREATE_SOME
 *
 * create new node agent
 *
 */
AgentCLI.prototype.create_some = function(n) {
    var self = this;
    var sem = new Semaphore(5);
    return Q.all(_.times(n, function() {
        return sem.surround(function() {
            return self.create();
        });
    }));
};

AgentCLI.prototype.create_some.helper = function() {
    dbg.log0("Create n agents:   create_some <n>");
};

/**
 *
 * START
 *
 * start agent
 *
 */
AgentCLI.prototype.start = function(node_name) {
    var self = this;

    var agent = self.agents[node_name];
    if (!agent) {
        agent = self.agents[node_name] = new Agent({
            address: self.params.address,
            node_name: node_name,
            prefered_port: self.params.port,
            storage_path: path.join(self.params.root_path, node_name),
            listen_on_http: self.params.listen_on_http
        });
        dbg.log0('agent inited', node_name);
    }

    return Q.fcall(function() {
        return agent.start();
    }).then(function(res) {
        dbg.log0('agent started', node_name);
        return res;
    }, function(err) {
        dbg.log0('FAILED TO START AGENT', node_name, err);
        throw err;
    });
};

AgentCLI.prototype.start.helper = function() {
    dbg.log0("Start a specific agent, if agent doesn't exist, will create it:   start <agent>");
};

/**
 *
 * STOP
 *
 * stop agent
 *
 */
AgentCLI.prototype.stop = function(node_name) {
    var self = this;

    var agent = self.agents[node_name];
    if (!agent) {
        dbg.log0('agent not found', node_name);
        return;
    }

    agent.stop();
    dbg.log0('agent stopped', node_name);
};

AgentCLI.prototype.stop.helper = function() {
    dbg.log0("Stop a specific agent:   stop <agent>");
};

/**
 *
 * LIST
 *
 * list agents status
 *
 */
AgentCLI.prototype.list = function() {
    var self = this;

    var i = 1;
    _.each(self.agents, function(agent, node_name) {
        dbg.log0('#' + i, agent.is_started ? '<ok>' : '<STOPPED>',
            'node', node_name, 'port', agent.http_port);
        i++;
    });
};

AgentCLI.prototype.list.helper = function() {
    dbg.log0("List all agents status");
};

/**
 *
 * Set Log Level
 *
 * Set logging level for a module
 *
 */
AgentCLI.prototype.set_log = function(mod, level) {
    var self = this;
    self._mod.set_level(level, mod);
    dbg.log0("Log for " + mod + " with level of " + level + " was set");

};

AgentCLI.prototype.set_log.helper = function() {
    dbg.log0('Setting log levels for module:   set_log <"module"> <level>');
};
/**
 *
 * Show
 *
 * help for specific API
 *
 */

AgentCLI.prototype.show = function(func_name) {
    var func = this[func_name];
    var helper = func && func.helper;

    // in the common case the helper is a function - so call it
    if (typeof(helper) === 'function') {
        return helper.call(this);
    }

    // if helper is string or something else we just print it
    if (helper) {
        dbg.log0(helper);
    } else {
        dbg.log0('help not found for function', func_name);
    }
};

function populate_general_help(general) {
    general.push('show("<function>"") to show help on a specific API');
}

function main() {

    var cli = new AgentCLI(argv);
    cli.init().done(function() {
        // start a Read-Eval-Print-Loop
        var repl_srv = repl.start({
            prompt: 'agent-cli > ',
            useGlobal: false
        });
        var help = {
            functions: [],
            variables: [],
            general: [],
        };
        _.forIn(cli, function(val, key) {
            if (typeof(val) === 'function') {
                repl_srv.context[key] = val.bind(cli);
                help.functions.push(key);
            } else {
                repl_srv.context[key] = val;
                help.variables.push(key);
            }
        });
        populate_general_help(help.general);
        repl_srv.context.help = help;
        repl_srv.context.dbg = dbg;
    }, function(err) {
        dbg.log0('init err:' + err);

    });
}

if (require.main === module) {
    main();
}
