"use strict";

const miniPackage = require("mini-package");

module.exports = {
    filename: __filename,
    dirname: __dirname,
    nodeModule: miniPackage.value,
};
