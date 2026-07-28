import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchTrainingLabel,
  prepareBatchTrainingFiles,
  runSequentialBatchTraining,
} from "../lib/vth-batch-learning-core.mjs";

test("selects supported images from a multi-file or folder batch", () => {
  const selection = prepareBatchTrainingFiles(
    [
      { name: "one.png", type: "image/png", size: 120 },
      { name: "two.JPEG", type: "", size: 130 },
      { name: "notes.txt", type: "text/plain", size: 20 },
      { name: "large.webp", type: "image/webp", size: 501 },
      { name: "three.jpg", type: "image/jpeg", size: 140 },
    ],
    { maximumFiles: 2, maximumBytes: 500 },
  );

  assert.deepEqual(
    selection.accepted.map((file) => file.name),
    ["one.png", "two.JPEG"],
  );
  assert.equal(selection.unsupported, 1);
  assert.equal(selection.oversized, 1);
  assert.equal(selection.overLimit, 1);
  assert.equal(selection.skipped, 3);
});

test("accepts every supported image when no explicit batch limit is supplied", () => {
  const files = Array.from({ length: 250 }, (_, index) => ({
    name: `distribution-${index + 1}.png`,
    type: "image/png",
    size: 120,
  }));
  const selection = prepareBatchTrainingFiles(files);

  assert.equal(selection.accepted.length, 250);
  assert.equal(selection.overLimit, 0);
  assert.equal(selection.skipped, 0);
});

test("builds anonymous sequential labels without exposing filenames", () => {
  assert.equal(
    buildBatchTrainingLabel("", 0, 100, false),
    "공용 VTH 일괄 분포 001",
  );
  assert.equal(
    buildBatchTrainingLabel("Wafer A", 8, 12, true),
    "Wafer A 09",
  );
});

test("continues a sequential batch after one image fails", async () => {
  const progress = [];
  const result = await runSequentialBatchTraining(
    ["one", "bad", "three"],
    async (value) => {
      if (value === "bad") throw new Error("invalid image");
      return value.toUpperCase();
    },
    (event) => progress.push(event.completed),
  );

  assert.deepEqual(result.successes, ["ONE", "THREE"]);
  assert.deepEqual(result.failures, [
    { index: 1, message: "invalid image" },
  ]);
  assert.deepEqual(progress, [0, 1, 2, 3]);
});
