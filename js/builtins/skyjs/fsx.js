"use strict";

// Public `skyjs/fsx` entry. The implementation lives in the private fs-core
// library, which also backs the legacy global io facade until NC0.8.

const fsx = require("../../internal/fs-core.js");

module.exports = fsx;
module.exports.fsx = fsx;
