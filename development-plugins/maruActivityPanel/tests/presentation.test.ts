import assert from "node:assert/strict";
import { test } from "node:test";

import { elapsedLabel, languageInfo } from "../src/userplugins/maruActivityPanel/presentation";

test("session duration handles future timestamps and hour boundaries", () => {
    assert.equal(elapsedLabel(5000, 0), "0m");
    assert.equal(elapsedLabel(0, 59999), "0m");
    assert.equal(elapsedLabel(0, 60 * 60000), "1h 0m");
    assert.equal(elapsedLabel(0, 119 * 60000), "1h 59m");
});

test("language badges use actual IDs and degrade safely", () => {
    assert.equal(languageInfo("css")[1], "CSS");
    assert.equal(languageInfo("typescriptreact")[0], "TypeScript React");
    assert.equal(languageInfo("custom-language")[0], "custom-language");
    assert.equal(languageInfo()[0], "Visual Studio Code");
});
