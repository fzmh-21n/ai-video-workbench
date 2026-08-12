import assert from "node:assert/strict";
import test from "node:test";

import { orderedDownloadFilename, orderedDownloadTasks } from "../src/taskDownload.js";

test("downloads completed batch videos in numeric chapter order", () => {
  const ordered = orderedDownloadTasks([
    { title: "第89节-juzi_pool", batchSection: 89, batchOrder: 890 },
    { title: "第81节-juzi_pool", batchSection: 81, batchOrder: 810 },
    { title: "第86节-juzi_pool", batchSection: 86, batchOrder: 860 },
  ]);
  assert.deepEqual(ordered.map((task) => task.batchSection), [81, 86, 89]);
});

test("uses fixed-width sequence and chapter numbers in download filenames", () => {
  assert.equal(
    orderedDownloadFilename({ title: "第86节-juzi_pool" }, 9, 12),
    "010-第086节-juzi_pool.mp4",
  );
});
