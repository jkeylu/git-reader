/*
Copyright (c) 2010 jKey Lu <jkeylu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

var Tools = require('./tools')
  , ChildProcess = require('child_process')
  , Path = require('path')
  , fs = require('fs');

// Keep stable stuff in memory 1 hour (in ms), 100ms for volatile stuff.
var CACHE_LIFE = [36300000, 100];

// effectively disable caching when testing
if (process.env.NODE_ENV === 'test') {
  CACHE_LIFE[0] = 100;
}

var gitENOENT = /fatal: (Path '([^']+)' does not exist in '([0-9a-f]{40})'|ambiguous argument '([^']+)': unknown revision or path not in the working tree.)/;

/*{{{ Git */
var Git = module.exports = function (repo) {
  this._gitCommands = [];
  this._gitDir = '';
  this._workTree = '';
  this._shaCache = false;
  this._shaQueue = false;
  this._branchsCache = {};
  this._branchsQueue = {};

  // Check the directory exists first.
  try {
    fs.statSync(repo);
  } catch (e) {
    throw new Error('Bad repo path: ' + repo);
  }

  try {
    // Check is this is a working repo
    this._gitDir = Path.join(repo, '.git')
    fs.statSync(this._gitDir);
    this._workTree = repo;
    this._gitCommands = ['--git-dir=' + this._gitDir, '--work-tree=' + this._workTree];

  } catch (e) {
    this._gitDir = repo;
    this._gitCommands = ['--git-dir=' + this._gitDir];
  }

};
/*}}}*/

// Decorator for async function that handles caching and concurrency queueing
// Anything with a 40 character hash version can be cached indefinetly, if the
// version is "fs" that means we're reading from the file system and will use
// an expiring cache.
/*{{{ function safe */
function safe(fn) {
  var cache = {}
    , queue = {};

  return function (version) {
    var args = Array.prototype.slice.call(arguments, 0, arguments.length - 1)
      , key = args.join(':')
      , callback = arguments[arguments.length - 1];

    if (!(version.length === 40 || version == 'fs')) {
      callback(new Error('Invalid version ' + version));
      return;
    }

    // Check local cache
    if (cache[key]) {
      process.nextTick(function () { callback(null, cache[key]); });
      return;
    }

    // Check if there is a line already
    if (queue[key]) {
      queue[key].push(callback);
      return;
    }

    // Otherwise, create a queue
    var localQueue = queue[key] = [callback];

    args[args.length] = function (err, value) {
      var cb;

      // If success, cache the value
      if (value) {
        cache[key] = value;
        // arguments[2] = time;
        // Set a timer to expire this cache item
        setTimeout(function () {
          cache[key] = false;
        }, version === 'fs' ? CACHE_LIFE[1] : CACHE_LIFE[0]);
      }

      // Flush the queue
      while (localQueue.length > 0) {
        cb = localQueue.shift();
        cb.apply(null, arguments);
      }

      queue[key] = false;
    };

    fn.apply(null, args);
  }

};
/*}}}*/

Git.prototype.safe = safe;

// Gets the sha for HEAD based on /HEAD and /packed-refs directly
/*{{{ Git.prototype.getHeadSha */
Git.prototype.getHeadSha = function (callback) {
  var that = this;

  // Pull from cache if possible
  if (that._shaCache) {
    callback(null, that._shaCache);
    return;
  }
  // Add our callback to the queue if there is already a query in progress
  if (that._shaQueue) {
    that._shaQueue.push(callback);
    return;
  }
  // Make sure we have a directory to read from
  if (!that._gitDir) {
    callback(new Error('gitDir not set yet!'));
    return;
  }

  // Start a new queue with our callback
  that._shaQueue = [callback];

  function groupCallback(err, sha) {
    var cb;

    while (that._shaQueue.length > 0) {
      cb = that._shaQueue.shift();
      cb.apply(null, arguments);
    }

    that._shaQueue = false;
  }

  var head, packedRefs, master;
  
  Path.exists(Path.join(that._gitDir, 'packed-refs'), function (exists) {
    if(exists) {
      getHEAD();

    } else {
      that.gitExec(['gc'], function (err) { getHEAD(); });
    }

  });
  
  function getHEAD() {
    fs.readFile(Path.join(that._gitDir, 'packed-refs'), 'ascii', function (err, result) {
      if (err) {
        groupCallback(err);
        return;
      }

      packedRefs = result;
      checkDone();
    });

    fs.readFile(Path.join(that._gitDir, 'HEAD'), 'ascii', function (err, result) {
      if (err) {
        groupCallback(err);
        return;
      }

      try {
        head = result.match(/^ref: (.*)\n$/)[1]

      } catch (err) {
        groupCallback(err);
        return;
      }

      fs.readFile(Path.join(that._gitDir, head), 'ascii', function (err, result) {
        master = result || null;
        checkDone();
      });

      checkDone();
    });

  }

  // When they're both done, parse out the sha and return it.
  function checkDone() {
    // Make sure all files have been read
    if (!(head && packedRefs && typeof master !== 'undefined')) {
      return;
    }

    // Parse the sha1 out of the files.
    try {
      if (master) {
        that._shaCache = master.match(/([a-f0-9]{40})\n/)[1];

      } else {
        that._shaCache = packedRefs.match(new RegExp('([a-f0-9]{40}) ' + head))[1];
      }

    } catch (err) {
      groupCallback(err);
      return;
    }

    // return the value to the caller's callback
    groupCallback(null, that._shaCache);

    // Leave the cache alive for a little bit in case of heavy load.
    setTimeout(function () { that._shaCache = false; }, CACHE_LIFE[1]);
  }
}
/*}}}*/

// Internal helper to talk to the git subprocess
/*{{{ Git.prototype.gitExec */
Git.prototype.gitExec = function (commands, encoding, callback) {
  var that = this;

  commands = that._gitCommands.concat(commands);
  var child = ChildProcess.spawn('git', commands)
    , stdout = []
    , stderr = []
    , exitCode;

  child.stdout.addListener('data', function (text) {
    stdout[stdout.length] = text;
  });

  child.stderr.addListener('data', function (text) {
    stderr[stderr.length] = text;
  });

  child.addListener('exit', function (code) {
    exitCode = code;
  });

  child.addListener('close', function () {
    if (exitCode > 0) {
      var err = new Error('git ' + commands.join(' ') + '\n' + Tools.join(stderr, 'utf8'));

      if (gitENOENT.test(err.message)) {
        err.errno = process.ENOENT;
      }

      callback(err);
      return;
    }

    callback(null, Tools.join(stdout, encoding));
  });

  child.stdin.end();
}
/*}}}*/

/*{{{ Git.prototype.logFile */
Git.prototype.logFile = function (version, path, callback) {
  var that = this;

  var safeLogFile = safe(function logFile(version, path, callback) {
    // Get the data from a git subprocess at the given sha hash.
    var commands
      , args = ['log', '-z', '--summary', version, '--', path];

    that.gitExec(args, 'utf8', function (err, text) {
      var log = {};

      if (err) {
        callback(err);
        return;
      }

      if (text.length === 0) {
        callback(null, []);
        return;
      }

      text.split('\0').forEach(function (entry) {
        var commit = entry.match(/^commit ([a-f0-9]{40})/)[1]
          , data = { message: entry.match(/\n\n([\s\S]*)/)[1].trim() };

        entry.match(/^[A-Z][a-z]*:.*$/gm).forEach(function (line) {
          var matches = line.match(/^([A-Za-z]+):\s*(.*)$/);
          data[matches[1].toLowerCase()] = matches[2];
        });

        log[commit] = data;
      });

      callback(null, log);
    });
  });

  that.logFile = safeLogFile;
  safeLogFile.apply(that, arguments);
};
/*}}}*/

/*{{{ Git.prototype.log */
Git.prototype.log = function (path, callback) {
  var that = this;

  that.getHeadSha(function (err, version) {
    if (err) {
      callback(err);
      return;
    }

    that.logFile(version, path, callback);
  });

}
/*}}}*/

// Loads a file from a git repo
/*{{{ Git.prototype.readFile */
Git.prototype.readFile = function (version, path, encoding, callback) {
  var that = this;

  var safeReadFile = safe(function readFile(version, path, encoding, callback) {
    // encoding is optional - if not specified we will return Buffer (not string)
    if(callback == null) {
      callback = encoding;
      encoding = null;
    }

    // Get the data from a git subprocess at the given sha hash.
    if (version.length === 40) {
      that.gitExec(['show', version + ':' + path], encoding, callback);
      return;
    }

    // Or load from the fs directly if requested.
    fs.readFile(Path.join(that._workTree, path), encoding, function (err, data) {
      if (err) {
        if (err.errno === process.ENOENT) {
          err.message += ' ' + JSON.stringify(path);
        }

        callback(err); return;
      }

      callback(null, data);
    });

  });

  that.readFile = safeReadFile;
  safeReadFile.apply(that, arguments);
};
/*}}}*/

// Reads a directory at a given version and returns an objects with two arrays
// files and dirs.
/*{{{ Git.prototype.readDir */
Git.prototype.readDir = function (version, path, callback) {
  var that = this;

  var safeReadDir = safe(function readDir(version, path, callback) {
    // Load the directory listing from git is a sha is requested
    if (version.length === 40) {
      that.readFile(version, path, 'utf-8', function (err, text) {
        if (err) {
          callback(err);
          return;
        }

        if (!(/^tree .*\n\n/).test(text)) {
          callback(new Error(combined + ' is not a directory'));
          return;
        }

        text = text.replace(/^tree .*\n\n/, '').trim();
        var files = []
          , dirs = [];

        text.split('\n').forEach(function (entry) {
          if (/\/$/.test(entry)) {
            dirs[dirs.length] = entry.substr(0, entry.length - 1);

          } else {
            files[files.length] = entry;
          }
        })

        callback(null, {
          files: files,
          dirs: dirs
        });

      });

      return;
    }

    // Otherwise read from the file system.
    var realPath = Path.join(that._workTree, path);
    fs.readdir(realPath, function (err, filenames) {
      if (err) {
        callback(err);
        return;
      }

      var count = filenames.length
        , files = []
        , dirs = [];

      filenames.forEach(function (filename) {
        fs.stat(Path.join(realPath, filename), function (err, stat) {
          if (err) {
            callback(err);
            return;
          }

          if (stat.isDirectory()) {
            dirs[dirs.length] = filename;

          } else {
            files[files.length] = filename;
          }

          count--;

          if (count === 0) {
            callback(null, {
              files: files,
              dirs: dirs
            });
          }

        });

      });

    });

  });

  that.readDir = safeReadDir;
  safeReadDir.apply(that, arguments);
};
/*}}}*/

// Generates a proper version string for external programs that want the
// newest version in the repository.  For working trees, this is the actual
// files on the HD, for bare repos this is the HEAD revision.
/*{{{ Git.prototype.getHead */
Git.prototype.getHead = function getHead(callback, forceHead) {
  var that = this;

  if (that._workTree && !forceHead) {
    callback(null, 'fs');
    return;
  };

  that.getHeadSha(callback);
}
/*}}}*/

/*{{{ Git.prototype.getBranchSha */
Git.prototype.getBranchSha = function getBranchSha(branch, callback) {
  var that = this
    , isFullPath = /^(heads|remotes|tags)\/(.+)/.test(branch)
    , isRemotes = /^([\w!@#$%+=-]+)\/([\w!@#$%+=-]+)$/.test(branch);

  function checkCache(branch) {
    function check(key) {
      if (that._branchsCache[key]) {
        callback(null, that._branchsCache[key]);
        return true;
      } else {
        return false;
      }
    }

    if (isFullPath) {
      return check(branch);

    } else if (isRemotes) {
      return check('remotes/' + branch);

    } else {
      return check('heads/' + branch)
        || check('remotes/(.+)/' + branch)
        || check('tags/' + branch);
    }
  }

  function checkQueue(branch) {
    if (that._branchsQueue[branch]) {
      that._branchsQueue[branch].push(callback);
      return true;

    } else {
      return false;
    }
  }

  if (checkCache(branch) || checkQueue(branch)) {
    return;
  }

  that._branchsQueue[branch] = [callback];

  function groupCallback(err, sha) {
    var localQueue = that._branchsQueue[branch]
      , cb;

    while (localQueue.length > 0) {
      cb = localQueue.shift();
      cb.apply(null, arguments);
    }

    that._branchsQueue[branch] = false;
  }

  function checkDone(key, sha) {
    that._branchsCache[key] = sha;

    groupCallback(null, sha);

    setTimeout(function () {
      that._branchsCache[key] = false;
    }, CACHE_LIFE[1]);
  }

  that.gitExec(['show-ref'], 'utf-8', function (err, lines) {
    if (err) { groupCallback(err); return; }

    function check(key) {
      var matches = lines.match(new RegExp('^([a-f0-9]{40}) refs/' + key + '$', 'm'));

      if (matches) {
        checkDone(key, matches[1]);
        return true;

      } else {
        return false;
      }
    }

    if (isFullPath) {
      if (check(branch)) { return; }

    } else if (isRemotes) {
      if (check('remotes/' + branch)) { return; }

    } else {
      if (check('heads/' + branch)
          || check('remotes/(.+)/' + branch)
          || check('tags/' + branch)) {
        return;
      }
    }

    groupCallback(new Error('Invalid branch ' + branch));
  });

};
/*}}}*/

// Expose the "safe" decorator so function that are dependent on a sha version
// can also be optimized.
Git.safe = safe;

