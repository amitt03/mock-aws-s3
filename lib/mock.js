/*
 * grunt-mock-s3
 * https://github.com/MathieuLoutre/grunt-mock-s3
 *
 * Copyright (c) 2013 Mathieu Triay
 * Licensed under the MIT license.
 */

'use strict';

var _ = require('underscore');
var fs = require('fs-extra');
var crypto = require('crypto');
var path = require('path');
var Buffer = require('buffer').Buffer;

var METADATA_SUFFIX = '.metadata';

var config = {};
// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
function walk (dir) {

	var results = [];
	var list = fs.readdirSync(dir);

	list.forEach(function (file) {

		file = dir + '/' + file;
		var stat = fs.statSync(file);

		if (stat && stat.isDirectory()) {
			results = results.concat(walk(file));
		}
        // ignore metadata files
		else if (!(endsWith(file, METADATA_SUFFIX))) {
			results.push(file);
		}
	});

	return results;
}

/** Add basePath to selected keys */
function applyBasePath(search) {
  if(_.isUndefined(config.basePath)) return search;
  var modifyKeys = ['Bucket', 'CopySource'];
  var ret = _.mapObject(search, function(value, key) {
    if(_.indexOf(modifyKeys, key) === -1) return value;
    return config.basePath + '/' + value;
  });
  return ret;
}

/** FakeStream object for mocking S3 streams */
function FakeStream (search) {
    this.src = search.Bucket + '/' + search.Key;
}
FakeStream.prototype.createReadStream = function () {
    return fs.createReadStream(this.src);
};

/** Mocks key pieces of the amazon s3 sdk */
function S3Mock(options) {
    if(!_.isUndefined(options) && !_.isUndefined(options.params))
      this.defaultOptions = _.extend({}, applyBasePath(options.params));
	this.config = {
		update: function() {}
	};
}
S3Mock.prototype = {
	listObjects: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));
		var files = walk(search.Bucket);

		var filtered_files = _.filter(files, function (file) { return !search.Prefix || file.replace(search.Bucket + '/', '').indexOf(search.Prefix) === 0; });
		var start = 0;
		var truncated = false;

		if (search.Marker) {
			var startFile = _(filtered_files).find(function(file) { return file.indexOf(search.Bucket  + '/' + search.Marker) === 0; });
			start = filtered_files.indexOf(startFile);
		}

		filtered_files = _.rest(filtered_files, start);

		if (filtered_files.length > 1000) {
			truncated = true;
			filtered_files = filtered_files.slice(0, 1000);
		}

		var result = {
			Contents: _.map(filtered_files, function (path) {

				return {
					Key: path.replace(search.Bucket + '/', ''),
					ETag: '"' + crypto.createHash('md5').update(fs.readFileSync(path)).digest('hex') + '"',
					LastModified: fs.statSync(path).mtime
				};
			}),
			CommonPrefixes: _.reduce(filtered_files, function (prefixes, path) {
				var prefix = path
					.replace(search.Bucket + '/', '')
					.split('/')
					.slice(0, -1)
					.join('/')
					.concat('/');
				return prefixes.indexOf(prefix) === -1 ? prefixes.concat([prefix]) : prefixes;
			}, []).map(function(prefix) {
				return {
					Prefix: prefix
				};
			}),
			IsTruncated: truncated
		};

		if (search.Marker) {
                        result.Marker = search.Marker;
                }
		if (truncated && search.Delimiter) {
			result.NextMarker = _.last(result.Contents).Key;
		}

		callback(null, result);
	},

	deleteObjects: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

		var deleted = [];
		var errors = [];

		_.each(search.Delete.Objects, function (file) {

            var path = search.Bucket + '/' + file.Key;
			if (fs.existsSync(path)) {
				deleted.push(file);
				fs.unlinkSync(path);

                // delete metadata files if exist
                var metadataPath = path + METADATA_SUFFIX;
                if (fs.existsSync(metadataPath)) {
                    fs.unlinkSync(metadataPath);
                }
			}
			else {
				errors.push(file);
			}
		});

		if (errors.length > 0) {
			callback("Error deleting objects", {Errors: errors, Deleted: deleted});
		}
		else {
			callback(null, {Deleted: deleted});
		}
	},

	deleteObject: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

        var path = search.Bucket + '/' + search.Key;
		if (fs.existsSync(path)) {
			fs.unlinkSync(path);

            // delete metadata files if exist
            var metadataPath = path + METADATA_SUFFIX;
            if (fs.existsSync(metadataPath)) {
                fs.unlinkSync(metadataPath);
            }

			callback(null, true);
		}
		else {
			callback(null, {});
		}
	},

	headObject: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

		if (!callback) {
			return new FakeStream(search);
		}
		else {

            // If metadata file exists then read it
            // Otherwise (for backward compatibility), read the real file
            var metadataExists = false;
            var path = search.Bucket + '/' + search.Key;
            var metaPath = path + METADATA_SUFFIX;
            try {
                if (fs.existsSync(metaPath)) {
                    metadataExists = true;
                    path = metaPath;
                }
            } catch (e) { /* don't care - file does not exist*/ }

			fs.readFile(path, function (err, data) {

				if (!err) {
					callback(null, {
						Key: search.Key,
						ETag: '"' + crypto.createHash('md5').update(data).digest('hex') + '"',
                        Metadata: metadataExists && JSON.parse(data),
						ContentLength: data.length
					});
				}
				else {
					if (err.code === 'ENOENT') {
						err.statusCode = 404;
					}
					callback(err, search);
				}
			});
		}
	},

	getObject: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

		if (!callback) {
			return new FakeStream(search);
		}
		else {
			fs.readFile(search.Bucket + '/' + search.Key, function (err, data) {

				if (!err) {

                    // Read metadata if exists
                    var metadataStr;
                    try {
                        metadataStr = fs.readFileSync(search.Bucket + '/' + search.Key + METADATA_SUFFIX);
                    }
                    catch (e) { /* don't care - file does not exist*/ }

                    callback(null, {
                        Key: search.Key,
                        ETag: '"' + crypto.createHash('md5').update(data).digest('hex') + '"',
                        Body: data,
                        Metadata: metadataStr && JSON.parse(metadataStr),
                        ContentLength: data.length
                    });
				}
				else {
					callback(err, search);
				}
			});
		}
	},

	copyObject: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

		fs.mkdirsSync(path.dirname(search.Bucket + '/' + search.Key));

		fs.copy(decodeURIComponent(search.CopySource), search.Bucket + '/' + search.Key, function (err, data) {

			callback(err, search);
		});
	},

	putObject: function (search, callback) {
		search = _.extend({}, this.defaultOptions, applyBasePath(search));

		var dest = search.Bucket + '/' + search.Key;

		if (typeof search.Body === 'string') {
			search.Body = new Buffer(search.Body);
		}

        if (search.Metadata) {
            fs.createFileSync(dest + METADATA_SUFFIX);
            fs.writeFileSync(dest + METADATA_SUFFIX, new Buffer(JSON.stringify(search.Metadata)));
        }

		if (search.Body instanceof Buffer) {
			fs.createFileSync(dest);
			fs.writeFile(dest, search.Body, function (err) {
				callback(err);
			});
		}
		else {
			fs.mkdirsSync(path.dirname(dest));

			var stream = fs.createWriteStream(dest);

			stream.on('finish', function () {
				callback(null, true);
			});

			search.Body.on('error', function (err) {
				callback(err);
			});

			stream.on('error', function (err) {
				callback(err);
			});

			search.Body.pipe(stream);
		}
	},

	upload: function (search, options, callback) {
		if (typeof options === 'function' && callback === undefined) {
			callback = options;
			options = null;
		}
		return this.putObject(search, callback);
	}

};

function endsWith(string, suffix) {
    var index = string && string.lastIndexOf(suffix);
    return suffix && index && index === string.length - suffix.length;
}

exports.config = config;
exports.S3 = function (options) {
	return new S3Mock(options);
};

