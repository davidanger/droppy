#!/usr/bin/env node
//-----------------------------------------------------------------------------
// Droppy - file server on node.js
// https://github.com/silverwind/Droppy
//-----------------------------------------------------------------------------
//Copyright (c) 2012 - 2013 silverwind
//
//Permission is hereby granted, free of charge, to any person obtaining a copy
//of this software and associated documentation files (the "Software"), to deal
//in the Software without restriction, including without limitation the rights
//to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//copies of the Software, and to permit persons to whom the Software is
//furnished to do so, subject to the following conditions:
//
//The above copyright notice and this permission notice shall be included in all
//copies or substantial portions of the Software.
//
//THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//SOFTWARE.
//-----------------------------------------------------------------------------
// Current limitiations:
// - When a client has multiple browser windows pointing to differrent folder,
//   only one of them will get updated. Need to figure out a way to map
//   WebSocket source ports to source ports of the HTTP connection.
//-----------------------------------------------------------------------------
// TODOs:
// - Recursive folder uploading & deleting
// - Login form styling
// - Encrypt login data on client
// - Multiple file operations like delete/move
// - Full drag & drop support
// - IE < 10 compatibilty, if possible
// - gzip compression
// - Check for any XSS
//-----------------------------------------------------------------------------
// vim: ts=4:sw=4
// jshint indent:4

"use strict";

var cache          = {},
    clients        = {},
    watchedDirs    = {},
    dirs           = {},
    userDB         = {},
    authClients    = {},
    server,
    lastRead,
    config;


var fs                 = require("fs"),
    formidable         = require("formidable"),
    WebSocketServer    = require("ws").Server,
    mime               = require("mime"),
    util               = require("util"),
    crypto             = require("crypto"),
    querystring        = require("querystring");

// Argument handler
if (process.argv.length > 2)
    handleArguments();

// Read config.json into config
readConfig();

if(config.useAuth) {
    readDB();
    if (Object.keys(userDB).length < 1) {
        console.log("Error: Authentication is enabled, but no user exists. Please create user(s) first using 'node droppy -adduser'.");
        process.exit(1);
    }
    cache.authHTML = fs.readFileSync(config.resDir + "auth.html", {"encoding": "utf8"});
}

cache.mainHTML = fs.readFileSync(config.resDir + "main.html", {"encoding": "utf8"});

// Process with setting up the files folder and bind to the listening port
setupFilesDir();
createListener();

//-----------------------------------------------------------------------------
// Set up the directory for files and start the server
function setupFilesDir() {
    fs.mkdir(config.filesDir, function (err) {
        if ( !err || err.code === "EEXIST") {
            return true;
        } else {
            console.log("Error accessing " + config.filesDir + ".");
            console.log(util.inspect(err));
            process.exit(1);
        }
    });
}
//-----------------------------------------------------------------------------
// Bind to listening port
function createListener() {
    if(!config.useSSL) {
        server = require("http").createServer(onRequest);
    } else {
        var key, cert;
        try {
            key = fs.readFileSync(config.httpsKey);
            cert = fs.readFileSync(config.httpsCert);
        } catch(error) {
            console.log("Error reading required SSL certificate or key.");
            console.log(util.inspect(error));
            process.exit(1);
        }
        server = require("https").createServer({key: key, cert: cert}, onRequest);
    }
    server.listen(config.port);
    server.on("listening", function() {
        //We're up - initialize everything
        var address = server.address();
        log("Listening on " + address.address + ":" + address.port);
        createWatcher(prefixBase("/"));
        setupSocket(server);
    });
    server.on("error", function (err) {
        if (err.code === "EADDRINUSE")
            console.log("Failed to bind to port " + config.port + ". Adress already in use.");
        else if (err.code === "EACCES")
            console.log("Failed to bind to port " + config.port + ". Need root to bind to ports < 1024.");
        else
            console.log("Error:" + util.inspect(err));
        process.exit(1);
    });
}
//-----------------------------------------------------------------------------
// Watch the directory for realtime changes and send them to the appropriate clients.
function createWatcher(folder) {
    var relativePath = folder.replace(config.filesDir.substring(0, config.filesDir.length - 1),"");
    var watcher = fs.watch(folder,{ persistent: true }, function(event){
        if(event === "change" || event === "rename") {
            // Files in a watched directory changed. Figure out which client(s) need updates
            // This part might be quite costly cpu-wise while files are being written, need
            // to figure out something better, like an object lookup.
            for (var client in clients) {
                if (clients.hasOwnProperty(client)) {
                    var clientDir = clients[client].directory;
                    if (clientDir === relativePath) {
                        readDirectory(clientDir, function() {
                            sendMessage(client,"UPDATE_FILES");
                        });
                    }
                }
            }
        }
    });
    watchedDirs[relativePath] = watcher;
}
//-----------------------------------------------------------------------------
// Create absolute directory link
function prefixBase(relativePath) {
    return config.filesDir.substring(0, config.filesDir.length - 1) + relativePath;
}
//-----------------------------------------------------------------------------
// WebSocket listener
function setupSocket(server) {
    var wss = new WebSocketServer({server : server});
    wss.on('connection', function(ws) {
        ws.on('message', function(message) {
            var msg = JSON.parse(message);
            var path = msg.data;
            var remoteIP = ws._socket.remoteAddress;
            var remotePort = ws._socket.remotePort;

            switch(msg.type) {
            case "REQUEST_UPDATE":
                path = path.replace(/&amp;/g,"&");
                clients[remoteIP] = { "directory": path, "ws": ws};
                readDirectory(path, function() {
                    sendMessage(remoteIP, "UPDATE_FILES");
                });
                break;
            case "CREATE_FOLDER":
                fs.mkdir(prefixBase(path), config.mode, function(err){
                    if(err) handleError(err);
                    readDirectory(clients[remoteIP].directory, function() {
                        sendMessage(remoteIP, "UPDATE_FILES");
                    });
                });
                break;
            case "DELETE_FILE":
                path = prefixBase(path);
                log("DEL:  " + remoteIP + ":" + remotePort + "\t\t" + path);
                fs.stat(path, function(err, stats) {
                    if(err) handleError(err);
                    if (stats.isFile()) {
                        fs.unlink(path, function(err) {
                            if(err) handleError(err);
                        });
                    } else if (stats.isDirectory()) {
                        fs.rmdir(path, function(err) {
                            if(err) handleError(err);
                            // TODO: handle ENOTEMPTY
                        });
                    }
                });
                break;
            case "SWITCH_FOLDER":
                if ( !path.match(/^\//) || path.match(/\.\./) ) return;
                path = path.replace(/&amp;/g,"&");
                clients[remoteIP] = { "directory": path, "ws": ws};
                updateWatchers(path);
                readDirectory(path, function() {
                    sendMessage(remoteIP, "UPDATE_FILES");
                });
                break;
            }
        });
    });
}
//-----------------------------------------------------------------------------
// Watch given directory and check if we need the other active watchers
function updateWatchers(newDir) {
    if (!watchedDirs[newDir]) {
        createWatcher(prefixBase(newDir));

        var neededDirs = {};
        for (var client in clients) {
            if (clients.hasOwnProperty(client)) {
                neededDirs[clients[client].directory] = true;
            }
        }

        for (var directory in watchedDirs) {
            if (watchedDirs.hasOwnProperty(directory)) {
                if (!neededDirs[directory]) {
                    watchedDirs[directory].close();
                    delete watchedDirs[directory];
                }
            }
        }
    }
}
//-----------------------------------------------------------------------------
// Send file list JSON over websocket
function sendMessage(IP, messageType) {
    var dir = clients[IP].directory;
    var data = JSON.stringify({
        "type"  : messageType,
        "folder": dir,
        "data"  : dirs[dir]
    });
    clients[IP].ws.send(data);
}
//-----------------------------------------------------------------------------
// Check if remote is authenticated before handing down the request
function onRequest(req, res) {
    if (config.useAuth) {
        if (isClientAuthenticated(req.socket.remoteAddress)) {
            processRequest(req, res);
        } else {
            displayLoginForm(req,res);
        }
    } else {
        processRequest(req, res);
    }

}
//-----------------------------------------------------------------------------
// Show login form for unauthenticated users
function displayLoginForm(req, res) {
    var method = req.method.toUpperCase();
    if (method === "GET") {
        if (req.url.match(/^\/res\//)) {
            handleResourceRequest(req, res, req.socket.remoteAddress + ":" + req.socket.remotePort);
        } else {
            serveHTML(res, cache.authHTML);
        }
    } else if (method === "POST") {
        var body = "";
        req.on("data", function(data) {
            body += data;
        });
        req.on("end", function() {
            var postData = querystring.parse(body);
            var clientIP = req.socket.remoteAddress;
            if (isValidUser(postData.username, postData.password)) {
                authClients[clientIP] = true;
                res.statusCode = 303;
                res.setHeader("Location", "/");
                res.end();

            } else {
                res.writeHead(401);
                res.write("Unauthorized");
                res.end();
            }
        });
    }
}

//-----------------------------------------------------------------------------
// GET/POST handler
function processRequest(req, res) {
    var method = req.method.toUpperCase();
    var socket = req.socket.remoteAddress + ":" + req.socket.remotePort;
    log("REQ:  " + socket + "\t" + method + "\t" + req.url);
    if (method === "GET") {
        if (req.url.match(/^\/res\//))
            handleResourceRequest(req,res,socket);
        else if (req.url.match(/^\/get\//))
            handleFileRequest(req,res,socket);
        else if (req.url === "/") {
            serveHTML(res, cache.mainHTML);
        } else {
            res.writeHead(404);
            res.end();
        }
    } else if (method === "POST" && req.url === "/upload") {
        handleUploadRequest(req,res,socket);
    }
}
//-----------------------------------------------------------------------------
// Serve resources. Everything from /res/ will be cached by both the server and client
function handleResourceRequest(req,res,socket) {
    var resourceName = unescape(req.url.substring(config.resDir.length -1));
    if (cache[resourceName] === undefined){
        var path = config.resDir + resourceName;
        fs.readFile(path, function (err, data) {
            if(!err) {
                cache[resourceName] = {};
                cache[resourceName].data = data;
                cache[resourceName].size = fs.statSync(unescape(path)).size;
                cache[resourceName].mime = mime.lookup(unescape(path));
                serveResource();
            } else {
                handleError(err);
                res.writeHead(404);
                res.end();
                return;
            }
        });
    } else {
        serveResource();
    }

    function serveResource() {
        log("SEND: " + socket + "\t\t" + resourceName + " (" + convertToSI(cache[resourceName].size) + ")");

        res.writeHead(200, {
            "Content-Type"      : cache[resourceName].mime,
            "Content-Length"    : cache[resourceName].size,
            "Cache-Control"     : "max-age=3600, public"
        });
        res.end(cache[resourceName].data);
    }
}
//-----------------------------------------------------------------------------
function handleFileRequest(req,res,socket) {
    var path = prefixBase(req.url.replace("get/",""));
    if (path) {
        var mimeType = mime.lookup(path);

        fs.stat(path, function(err,stats){
            if(err) {
                res.writeHead(500);
                res.end();
                handleError(err);
            }
            log("SEND: " + socket + "\t\t" + path + " (" + convertToSI(stats.size) + ")");
            res.writeHead(200, {
                "Content-Type"      : mimeType,
                "Content-Length"    : stats.size
            });
            fs.createReadStream(path, {"bufferSize": 4096}).pipe(res);
        });
    }
}
//-----------------------------------------------------------------------------
function handleUploadRequest(req,res,socket) {
    if (req.url === "/upload" ) {
        var form = new formidable.IncomingForm();
        var address = req.socket.remoteAddress;
        var uploadedFiles = [];
        form.uploadDir = config.filesDir;
        form.parse(req);

        //Change the path from a temporary to the actual files directory
        form.on("fileBegin", function(name, file) {
            if (clients[address].directory === "/")
                file.path = form.uploadDir + file.name;
            else
                file.path = prefixBase(clients[address].directory) + "/" + file.name;
            uploadedFiles.push(file.path);

            log("RECV: " + socket + "\t\t" + file.path );
        });

        form.on('end', function() {
            uploadedFiles.forEach(function(file) {
                fs.chmod(file, config.mode, function(err) {
                    if(err) handleError(err);
                });
            });
        });

        form.on("error", function(err) {
            handleError(err);

        });

        res.writeHead(200, {
            "Content-Type" : "text/html"
        });
        res.end();
    }
}
//-----------------------------------------------------------------------------
// Read the directory's content and store it in "dirs"
var readDirectory = debounce(function (root, callback){
    lastRead = new Date();
    fs.readdir(prefixBase(root), function(err,files) {
        if(err) handleError(err);
        if(!files) return;

        var dirContents = {};

        if (files.length === 0) {
            dirs[root] = dirContents;
            callback();
        }

        var lastFile = files.length;
        var counter = 0;

        for(var i = 0 ; i < lastFile; i++){
            var filename = files[i], type;
            inspectFile(filename);
        }

        function inspectFile(filename) {
            fs.stat(prefixBase(root) + "/" + filename, function(err, stats) {
                counter++;
                if(err) handleError(err);
                if (stats.isFile())
                    type = "f";
                if (stats.isDirectory())
                    type = "d";
                if (type === "f" || type === "d")
                    dirContents[filename] = {"type": type, "size" : stats.size};

                // All callbacks have fired
                if (counter === lastFile) {
                    dirs[root] = dirContents;
                    callback();
                }
            });


        }
    });
},config.readInterval);
//-----------------------------------------------------------------------------
// Logging and error handling helpers
function log(msg) {
    console.log(getTimestamp() + msg);
}

function handleError(err) {
    if (typeof err === "object") {
        if (err.message)
            log(err.message);
        if (err.stack)
            log(err.stack);
    }
}

process.on("uncaughtException", function (err) {
    log("=============== Uncaught exception! ===============");
    handleError(err);
});
//-----------------------------------------------------------------------------
// Argument handler
function handleArguments() {
    var args = process.argv.slice(2);
    var option = args[0];

    switch(option) {
    case "-adduser":
        if (args.length === 3 ) {
            addUser(args[1],args[2]);
        } else {
            printUsage();
            process.exit(1);
        }
        break;
    case "-help":
        printUsage();
        process.exit();
        break;
    default:
        process.stdout.write("Unknown argument. See 'node droppy -? for help.'");
        process.exit(1);
        break;
    }

    function printUsage() {
        process.stdout.write("Droppy - file server on node.js (https://github.com/silverwind/Droppy)\n");
        process.stdout.write("Usage: node droppy [option] [option arguments]\n\n");
        process.stdout.write("-help \t\t\t\tPrint this help\n");
        process.stdout.write("-adduser username password\tCreate a new user for authentication\n");
    }
}
//-----------------------------------------------------------------------------
// Read and validate config.json
function readConfig() {
    try {
        config = JSON.parse(fs.readFileSync("./config.json"));
    } catch (e) {
        console.log("Error reading ./config.json\n\n");
        console.log(util.inspect(e));
        process.exit(1);
    }
    var opts = ["filesDir","resDir","useSSL","useAuth","port","readInterval","httpsKey","httpsCert","userDB"];
    for (var i = 0, len = opts.length; i < len; i++) {
        if (config[opts[i]] === undefined) {
            console.log("Error: Missing property in config.json: " + opts[i]);
            process.exit(1);
        }
    }
}
//-----------------------------------------------------------------------------
// Read and validate user database
function readDB() {
    if (config.useAuth === true) {
        try {
            userDB = JSON.parse(fs.readFileSync(config.userDB));
        } catch (e) {
            console.log("Error reading "+ config.userDB + "\n\n");
            console.log(util.inspect(e));
            process.exit(1);
        }
    }
}
//-----------------------------------------------------------------------------
// Get a SHA256 hash of a string
function getHash(string) {
    return crypto.createHmac("sha256", new Buffer(string, 'utf8')).digest("hex");
}
//-----------------------------------------------------------------------------
// Add a user to the database save it to disk
function addUser (user, password) {
    readConfig();
    readDB();
    if (userDB[user] !== undefined) {
        console.log("User " + user + " already exists!");
        process.exit(1);
    } else {
        userDB[user] = getHash(password + "!salty!" + user);
        try {
            fs.writeFileSync(config.userDB, JSON.stringify(userDB));
            console.log("User " + user + " sucessfully added.");
            process.exit();
        } catch (e) {
            console.log("Error writing "+ config.userDB + "\n\n");
            console.log(util.inspect(e));
            process.exit(1);
        }
    }
}
//-----------------------------------------------------------------------------
// Check if user/password is valid
function isValidUser(user, password) {
    if (userDB[user] === getHash(password + "!salty!" + user))
        return true;
    else
        return false;
}
//-----------------------------------------------------------------------------
// Checks if a client is authenticated
function isClientAuthenticated(IP) {
    if (authClients[IP] !== undefined)
        return true;
    else
        return false;
}
//-----------------------------------------------------------------------------
// Serve a HTML page
function serveHTML(res,resource) {
    res.writeHead(200, {
        "content-type"  : "text/html"
    });
    res.end(resource);
}
//-----------------------------------------------------------------------------
// Helper function for log timestamps
function getTimestamp() {
    var currentDate = new Date();
    var day = currentDate.getDate();
    var month = currentDate.getMonth() + 1;
    var year = currentDate.getFullYear();
    var hours = currentDate.getHours();
    var minutes = currentDate.getMinutes();
    var seconds = currentDate.getSeconds();

    if (hours < 10) hours = "0" + hours;
    if (minutes < 10) minutes = "0" + minutes;
    if (seconds < 10) seconds = "0" + seconds;

    return month + "/" + day + "/" + year + " "+ hours + ":" + minutes + ":" + seconds + " ";
}
//-----------------------------------------------------------------------------
// Helper function for size values
function convertToSI(bytes) {
    var kib = 1024;
    var mib = kib * 1024;
    var gib = mib * 1024;
    var tib = gib * 1024;

    if ((bytes >= 0) && (bytes < kib)) {
        return bytes + ' B';
    } else if ((bytes >= kib) && (bytes < mib)) {
        return (bytes / kib).toFixed(2) + ' KiB';
    } else if ((bytes >= mib) && (bytes < gib)) {
        return (bytes / mib).toFixed(2) + ' MiB';
    } else if ((bytes >= gib) && (bytes < tib)) {
        return (bytes / gib).toFixed(2) + ' GiB';
    } else if (bytes >= tib) {
        return (bytes / tib).toFixed(2) + ' TiB';
    } else {
        return bytes + ' B';
    }
}
//-----------------------------------------------------------------------------
// underscore's debounce
// https://github.com/documentcloud/underscore
function debounce(func, wait, immediate) {
    var timeout, result;
    return function() {
        var context = this, args = arguments;
        var later = function() {
            timeout = null;
            if (!immediate) result = func.apply(context, args);
        };
        var callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) result = func.apply(context, args);
        return result;
    };
}