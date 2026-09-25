"use strict";

const frame = require("../internal/binary-frame.js");

skynet.start(() => {
    skynet.dispatch("lua", (msg) => {
        const { header, body } = frame.frameDecode(msg);
        // Echo the body straight back, adding a marker to the header.
        return frame.frameEncode(Object.assign({}, header, { echoed: true }), body);
    });
});
