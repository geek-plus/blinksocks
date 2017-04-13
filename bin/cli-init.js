#!/usr/bin/env node

/* eslint-disable quotes */
const fs = require('fs');
const crypto = require('crypto');

/**
 * return a fixed length random string from array
 * @param array
 * @param len
 * @returns {string}
 */
function random(array, len) {
  const size = array.length;
  const randomIndexes = crypto.randomBytes(len).toJSON().data;
  return randomIndexes.map((char) => array[char % size]).join('');
}

const js = `
module.exports = {
  "host": "localhost",
  "port": 1080,
  "servers": [],
  "key": "${random('abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+<>?:|{}ABCDEFGHIJKLMNOPQRSTUVWXYZ', 16)}",
  "presets": [{
    "name": "origin",
    "params": {}
  }, {
    "name": "aead",
    "params": {
      "method": "aes-128-gcm",
      "info": "ss-subkey"
    }
  }],
  "redirect": "",
  "timeout": 600,
  "log_level": "info",
  "profile": false,
  "watch": true
};`;

const file = 'blinksocks.config.js';

fs.writeFile(file, js, function (err) {
  if (err) {
    throw err;
  }
});
