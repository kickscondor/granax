'use strict';

const async = require('async');
const fs = require('fs');
const { request } = require('https');
const ncp = require('ncp');
const _7z = require('7zip')['7z'];
const path = require('path');
const childProcess = require('child_process');
const os = require('os');
const { tor: getTorPath, bin: BIN_DIR } = require('..');
const getLatestTorBrowserVersion = require('latest-torbrowser-version');
const rimraf = require('rimraf');
const mv = require('mv');
const granax = require('../index');
const ProgressBar = require('progress');
const { Transform } = require('stream');


/**
 * Get the platform specific download like for TBB by version
 * @param {string} platform
 * @param {string} version
 * @param {function} callback
 * @returns {string}
 */
exports.getTorBrowserLink = function(platform, version, callback) {
  if (typeof version === 'function') {
    callback = version;
    version = undefined;
  }

  function createHref(v) {
    const link = `https://dist.torproject.org/torbrowser/${v}`;

    switch (platform) {
      case 'win32':
        return `${link}/torbrowser-install-${v}_ALL.exe`;
      case 'darwin':
        return `${link}/TorBrowser-${v}-osx64_ALL.dmg`;
      case 'android':
      case 'linux':
        return os.arch() === 'x64'
          ? `${link}/tor-browser-linux64-${v}_ALL.tar.xz`
          : `${link}/tor-browser-linux32-${v}_ALL.tar.xz`
      default:
        throw new Error(`Unsupported platform "${platform}"`);
    }
  }

  if (version) {
    callback(null, createHref(version));
  } else {
    getLatestTorBrowserVersion(platform, !!process.env.GRANAX_USE_TOR_ALPHA)
      .then(version => callback(null, createHref(version)))
      .catch(err => callback(err));
  }
};

/**
 * Downloads the package to the given directory
 * @param {string} link
 * @param {string} target
 * @param {function} callback
 */
exports.downloadTorBrowserBundle = function(link, target, callback) {
  if (fs.existsSync(target)) {
    callback()
    return
  }

  request(link, (res) => {
    if (res.statusCode !== 200) {
      callback(new Error(
        'Failed to download Tor Bundle, status code: ' + res.statusCode
      ));
    } else {
      const len = parseInt(res.headers['content-length'], 10);
      const progress = new ProgressBar('[:bar] :rate/bps :percent :etas', {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: len
      });

      res.pipe(new Transform({
        transform: (data, enc, cb) => {
          progress.tick(data.length);
          cb(null, data);
        }
      })).pipe(fs.createWriteStream(target))
        .on('finish', callback)
        .on('error', callback);
    }
  }).end();
};

/**
 * Unpacks the package at the given path based on platform and callback with
 * the path to the tor executable
 * @param {string} bundle
 * @param {function} callback
 */
exports.unpackTorBrowserBundle = function(bundle, callback) {
  switch(path.extname(bundle)) {
    case '.exe':
      return exports._unpackWindows(bundle, callback);
    case '.dmg':
      return exports._unpackMacintosh(bundle, callback);
    case '.xz':
      return exports._unpackLinux(bundle, callback);
    default:
      throw new Error('Unsupported bundle type');
  }
};

/**
 * @private
 */
exports._unpackWindows = function(bundle, callback) {
  const extract = childProcess.spawn(_7z, [
    'x', bundle
  ], { cwd: BIN_DIR });

  extract.on('close', (code) => {
    callback(code >= 0 ? null : new Error('Failed to unpack bundle'),
             getTorPath('win32'));
  });
};

/**
 * @private
 */
exports._unpackMacintosh = function(bundle, callback) {
  const mounter = childProcess.spawn('hdiutil', [
    'attach',
    '-mountpoint',
    path.join(BIN_DIR, '.tbb'),
    bundle
  ], { cwd: BIN_DIR });

  mounter.on('close', (code) => {
    if (code < 0) {
      return callback(new Error('Failed to unpack bundle'));
    }

    ncp.ncp(
      path.join(BIN_DIR, '.tbb', 'Tor Browser.app'),
      path.join(BIN_DIR, '.tbb.app'),
      (err) => {
        if (err) {
          return callback(new Error('Failed to unpack bundle'));
        }

        const extract = childProcess.spawn('hdiutil', [
          'detach',
          path.join(BIN_DIR, '.tbb')
        ], { cwd: BIN_DIR });

        extract.on('close', (code) => {
          if (code < 0) {
            callback(new Error('Failed to unpack bundle'));
          }

          callback(null, getTorPath('darwin'));
        });
      }
    );
  });
};

/**
 * @private
 */
exports._unpackLinux = function(bundle, callback) {
  const extract = childProcess.spawn('tar', [
    'xJf', bundle
  ], { cwd: BIN_DIR });

  extract.stdout.pipe(process.stdout);
  extract.stderr.pipe(process.stderr);

  extract.on('close', (code) => {
    callback(code <= 0 ? null : new Error('Failed to unpack bundle'),
             getTorPath('linux'));
  });
};

/**
 * Detects the platform and installs TBB
 * @param {function} callback
 */
exports.install = function(callback) {
  let basename = null;

  if (process.env.GRANAX_USE_SYSTEM_TOR) {
    // NB: Use the system installation of Tor on android and linux
    console.log('Skipping automatic Tor installation...');
    console.log('Be sure to install Tor using your package manager!');
    return;
  }

  exports.getTorBrowserLink(
    os.platform(),
    process.env.GRANAX_TOR_VERSION,
    (err, link) => {
      if (err) {
        return callback(err);
      }

      console.log(`Downloading Tor Bundle from ${link}...`);
      basename = path.basename(new URL(link).pathname)
      basename = path.join(BIN_DIR, basename);
      try { fs.mkdirSync(BIN_DIR, {recursive: true}) } catch {}
      exports.downloadTorBrowserBundle(link, basename, (err) => {
        if (err) {
          return callback(err);
        }

        console.log(`Unpacking Tor Bundle into ${BIN_DIR}...`);
        exports.unpackTorBrowserBundle(basename, (err, bin) => {
          if (err) {
            return callback(err);
          }

          if (process.env.GRANAX_TOR_VERSION) {
            return callback(null, bin);
          }

          const source = path.dirname(granax.tor(os.platform()));
          const dest = path.join(BIN_DIR, 'Tor');
          rimraf.sync(dest);

          console.log(`Moving tor binary and libs to ${dest}...`);
          mv(source, dest, (err) => {
            if (err) {
              return callback(err);
            }

            console.log('Cleaning up...');
            rimraf.sync(granax.tor(os.platform()));

            switch (os.platform()) {
              case 'win32':
                rimraf.sync(path.join(BIN_DIR, 'Browser'));
                break;
              case 'darwin':
                rimraf.sync(path.join(BIN_DIR, '.tbb.app'));
                break;
              case 'android':
              case 'linux':
                rimraf.sync(path.join(BIN_DIR, 'tor-browser_ALL'));
                break;
              default:
            }

            callback(null, path.join(BIN_DIR, 'Tor', path.basename(
              granax.tor(os.platform())
            )));
          });
        });
      });
    }
  );
};

if (require.main === module) {
  exports.install((err) => {
    if (err) {
      console.log(err.message);
      process.exit(1);
    } else {
      console.log('Finished!')
      process.exit(0);
    }
  });
}
