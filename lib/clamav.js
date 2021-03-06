'use strict';

var child   = require('child_process');
var fs      = require('fs');
var net     = require('net');
var path    = require('path');
var util    = require('util');

var logger  = require('./logger');
var BaseScanner = require('./base-scanner');
var clamStream  = require('./clamav-stream');

function Scanner (name) {
    BaseScanner.call(this);

    this.name = name || 'clamav';

    this.init();

    if (!this.cfg.socket)   this.cfg.socket   = 'clamd.socket';
    if (!this.cfg.cli.bin)  this.cfg.cli.bin  = 'clamdscan';
    if (!this.cfg.cli.args) this.cfg.cli.args = '';
    if (!this.cfg.net.host) this.cfg.net.host = '0.0.0.0';
    if (!this.cfg.net.port) this.cfg.net.port = '3310';

    this.failFile = path.resolve('test/files/eicar.eml');
    this.passFile = path.resolve('test/files/clean.eml');

    // logger.info(util.inspect(this, { depth: null }));
}

util.inherits(Scanner, BaseScanner);

Scanner.prototype.scanBin = function (file, done) {
    var s = this;
    if (!s.found.cli) {
        return done(new Error('cli not found, did you run binFound yet?'));
    }

    var cmd = s.found.cli + ' ' + file;
    // logger.info(cmd);

    child.exec(cmd, function (error, stdout, stderr) {
        if (error) {
            if (error.code === 1) {
                // normal when a virus is found.
            }
            else {
                logger.error(error);
            }
        }
        if (stderr) {
            logger.error('stderr: ' + stderr);
            return done(stderr);
        }

        if (!stdout) return done(new Error('no stdout?'));

        // logger.info('stdout: ' + stdout);
        return done(null, s.parseScanReply(stdout));
    });
};

Scanner.prototype.parseScanReply = function (response) {

    var result = {
        pass: [],
        fail: [],
        error: [],
        name: this.name,
        raw: response,
    };

    // logger.info(response);
    // Example responses from clamdscan & clamd
    // /tmp/clean.eml: OK
    // /tmp/eicar.eml: Eicar-Test-Signature FOUND
    // stream: Eicar-Test-Signature FOUND

    var lineOne = response.split(/[\r\n]/).shift();

    if (/OK[\0|\n]?$/.test(lineOne)) {
        result.pass.push('OK');
        return result;
    }

    if (/FOUND[\0|\n]?$/.test(lineOne)) {
        var parts = lineOne.split(/:\s/);
        result.fail.push(parts[1].split(/\s/).shift());
        return result;
    }

    if (/ERROR/.test(response)) {
        result.error.push(response);
    }

    return result;
};

Scanner.prototype.ping = function (socket, connOpts, done) {
    var pingErr;

    socket.connect(connOpts, function () {
        socket.write('nPING\n');
    })
    .on('end', function () {
        if (pingErr) return done(pingErr);
        done(null, true);
    })
    .on('data', function (data) {
        if (data.toString() === 'PONG\n') {
            return socket.end();
        }
        pingErr = new Error('unexpected: ' + data.toString());
        socket.end();
    })
    .on('close', function (err) {
        if (err) {
            logger.error('on.close');
            logger.error(err);
            logger.error('transmision errors encountered');
        }
    })
    .on('error', function (err) {
        logger.error('error');
        done(err);
    });
};

Scanner.prototype.scanTcp = function (file, done) {
    var s = this;
    if (!s.found.tcp) {
        return done(new Error('TCP listener not found'));
    }

    var scanErr = '';
    var socket = s.getClamSocket(scanErr, done);

    socket.connect(s.cfg.net, function () {
        socket.write('zINSTREAM\0', function () {
            fs.createReadStream(file)
            .pipe(new clamStream()).pipe(socket)
            .on('end', function () {
                // logger.info('sent file!');
            })
            .on('error', function (err) {
                logger.error(err);
            });
        });
    });
};

Scanner.prototype.scanSocket = function (file, done) {
    var s = this;
    if (!file) return done(new Error('file is required!'));
    if (!s.found.socket) {
        return done(new Error('TCP listener not found'));
    }

    var scanErr = '';
    var socket = s.getClamSocket(scanErr, done);

    socket.connect(s.found.socket, function () {
        if (typeof file === 'string' && file[0] !== '/') {
            file = path.resolve(file);
        }
        socket.write('SCAN ' + file);
    });
};

Scanner.prototype.getClamSocket = function (scanErr, done) {
    var s = this;
    var socket = new net.Socket();

    socket.setTimeout(s.cfg.timeout * 1000);
    socket.on('end', function () {
        if (scanErr) return done(scanErr);
    })
    .on('data', function (data) {
        socket.end();
        done(null, s.parseScanReply(data.toString()));
    })
    .on('close', function (err) {
        if (err) {
            logger.error('on.close');
            logger.error(err);
            logger.error('transmision errors encountered');
        }
    })
    .on('error', function (err) {
        logger.error('error');
        done(err);
    });

    return socket;
};

Scanner.prototype.install = function (done) {
    switch (process.platform) {
        case 'darwin':
            return this.installMacOSX(done);
        case 'freebsd':
            return this.installFreeBSD(done);
        case 'linux':
            return this.installLinux(done);
        default:
            done(new Error('install not supported on ' + process.platform));
    }
};

Scanner.prototype.installMacOSX = function (done) {
    // sudo port install clamav clamav-servers
    // sudo launchctl load -w /Library/LaunchDaemons/org.macports.freshclam.plist
    // sudo launchctl load -w /Library/LaunchDaemons/org.macports.clamd.plist
};

Scanner.prototype.installFreeBSD = function (done) {
    // sudo pkg install -y clamav
    // echo 'clamav_freshclam_enable="YES"' | sudo tee -a /etc/rc.conf -
    // echo 'clamav_clamd_enable="YES"' | sudo tee -a /etc/rc.conf -
    // sudo service clamav-freshclam start
    // sudo service clamav-clamd start
};

Scanner.prototype.installLinux = function (done) {
    // sudo apt-get install -y clamav-daemon clamav-freshclam libclamunrar6
};

module.exports = {
    createScanner: function (name) {
        return new Scanner(name);
    }
};
