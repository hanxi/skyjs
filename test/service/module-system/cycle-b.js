"use strict";

module.exports = { tag: "b" };
const cycleA = require("./cycle-a.js");
module.exports.aTag = cycleA.tag;
