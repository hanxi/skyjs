"use strict";

module.exports = { tag: "a" };
const cycleB = require("./cycle-b.js");
module.exports.after = cycleB.tag;
