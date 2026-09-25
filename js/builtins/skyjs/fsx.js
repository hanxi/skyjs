"use strict";

// Public `skyjs/fsx` entry: SkyJS-native file API. Shares internal/fs-core
// (and therefore the C primitives) with the Node `fs` facade.

const fsx = require("../../internal/fs-core.js");
const constants = require("../fs/constants.js");

const merged = Object.assign({}, fsx, { constants });
module.exports = merged;
module.exports.fsx = merged;
