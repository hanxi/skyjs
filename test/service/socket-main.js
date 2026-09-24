// Task 4 acceptance: JS TCP echo server + JS client, both in the same node.
// TCP is a byte stream, so the test uses one request/response round trip and
// verifies the echoed payload content, then closes both ends.
const socket = require("../../js/internal/net-core.js");

skynetcore.runtime.error("MAIN socket test starting");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "SOCKET:" + msg);
});

const listenId = socket.listen("127.0.0.1", 18765, (connId) => {
    skynetcore.runtime.error("SOCKTEST accept conn " + connId);
    socket.start(connId, (data) => {
        socket.write(connId, data.toUpperCase());
    }, (id) => {
        skynetcore.runtime.error("SOCKTEST conn " + id + " closed");
    });
    // accepted fds start in PAccept state: must resume to receive data
    socket.resume(connId);
});
skynetcore.runtime.error("SOCKTEST listen id=" + listenId);

// client side (after the server has had a moment to bind)
skynet.timeout(10, () => {
    socket.connect("127.0.0.1", 18765, (id) => {
        skynetcore.runtime.error("SOCKTEST connected fd=" + id);
        socket.start(id, (data) => {
            skynetcore.runtime.error("SOCKTEST echo got: " + data);
            if (data === "HELLO-SKYJS") {
                socket.close(id);
                skynetcore.runtime.error("SOCKTEST ALL_ECHO_OK");
            }
        }, (id) => {
            skynetcore.runtime.error("SOCKTEST client closed " + id);
        }, (id, err) => {
            skynetcore.runtime.error("SOCKTEST client error " + id + " " + err);
        });
        socket.write(id, "hello-skyjs");
    });
});
