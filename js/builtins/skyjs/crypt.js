"use strict";

// Public `skyjs/crypt` entry. The implementation lives in the private
// crypt-core library; this facade keeps the stable module id independent of
// the core's internal layout.

const cryptCore = require("../../internal/crypt-core.js");

module.exports = cryptCore;
module.exports.crypt = cryptCore;
