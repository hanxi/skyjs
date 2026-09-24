// Task 2 acceptance: skynet.getenv over the QuickJS-parsed config.
// Exercises every JSON type (number/float/bool/string/null/object/array/mixed)
// plus nested objects, standard config keys, and the deep-frozen guarantee.
// Prints [PASS]/[FAIL] per assertion and a NESTED CONFIG TEST PASSED marker.
// Uses the global `skynet` installed by bootstrap, like other test services --
// snjs eval's scripts as global code, so no ES `import` here.
"use strict";

skynet.start(async () => {
    let pass = 0;
    let fail = 0;

    function assertEq(label, got, expected) {
        // deep equal for objects/arrays via JSON, === for primitives
        const ok = (typeof expected === "object" && expected !== null)
            ? JSON.stringify(got) === JSON.stringify(expected)
            : got === expected;
        if (ok) {
            pass++;
            console.log("[PASS]", label);
        } else {
            fail++;
            console.error("[FAIL]", label, "got:", JSON.stringify(got),
                "expected:", JSON.stringify(expected));
        }
    }

    function assertType(label, got, expectedType) {
        const gotType = Array.isArray(got) ? "array" : typeof got;
        if (gotType === expectedType) {
            pass++;
            console.log("[PASS]", label);
        } else {
            fail++;
            console.error("[FAIL]", label, "got type:", gotType,
                "expected:", expectedType);
        }
    }

    // number
    assertType("test_number type", skynet.getenv("testNumber"), "number");
    assertEq("test_number value", skynet.getenv("testNumber"), 42);

    // float
    assertType("test_float type", skynet.getenv("testFloat"), "number");
    assertEq("test_float value", skynet.getenv("testFloat"), 3.14);

    // boolean
    assertType("test_bool_true type", skynet.getenv("testBoolTrue"), "boolean");
    assertEq("test_bool_true value", skynet.getenv("testBoolTrue"), true);
    assertEq("test_bool_false value", skynet.getenv("testBoolFalse"), false);

    // string
    assertType("test_string type", skynet.getenv("testString"), "string");
    assertEq("test_string value", skynet.getenv("testString"), "hello world");

    // null
    assertEq("test_null value", skynet.getenv("testNull"), null);

    // object (nested)
    assertType("test_object type", skynet.getenv("testObject"), "object");
    const obj = skynet.getenv("testObject");
    assertEq("test_object.host", obj.host, "127.0.0.1");
    assertEq("test_object.port", obj.port, 8080);
    assertEq("test_object.nested.deep", obj.nested.deep, true);

    // array
    assertEq("test_array is array", Array.isArray(skynet.getenv("testArray")), true);
    assertEq("test_array value", skynet.getenv("testArray"), [1, 2, 3]);

    // mixed array
    assertEq("test_mixed_array value", skynet.getenv("testMixedArray"),
        ["a", 1, true, null]);

    // standard config keys also work (primitives flattened into env too)
    assertType("thread type", skynet.getenv("thread"), "number");
    assertEq("thread value", skynet.getenv("thread"), 2);
    assertType("bootstrap type", skynet.getenv("bootstrap"), "string");

    // a key absent from the JSON falls back to the flat env string (C default)
    assertType("cpath type", skynet.getenv("cpath"), "string");

    // frozen (immutable): mutating a returned object must have no effect
    let frozenOk;
    try {
        const o = skynet.getenv("testObject");
        o.host = "MUTATED";
        frozenOk = (o.host !== "MUTATED"); // sloppy: silently fails; strict: throws
    } catch (e) {
        frozenOk = true; // TypeError from frozen object
    }
    assertEq("config is frozen", frozenOk, true);

    // summary
    console.log(`\ngetenv test: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.error("NESTED CONFIG TEST FAILED");
    } else {
        console.log("NESTED CONFIG TEST PASSED");
    }

    skynet.exit();
});
