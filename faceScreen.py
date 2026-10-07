import base64
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np


def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    models = Path(__file__).parent / ".workbench-data" / "face-models"
    detector_path = models / "face_detection_yunet_2023mar.onnx"
    recognizer_path = models / "face_recognition_sface_2021dec.onnx"
    if not detector_path.is_file() or not recognizer_path.is_file():
        raise RuntimeError("人脸模型尚未安装，请先运行 setup-face-screen.ps1")

    detector = cv2.FaceDetectorYN.create(str(detector_path), "", (320, 320), 0.8)
    recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), "")

    def faces_in(path):
        image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return []
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, faces = detector.detect(image)
        results = []
        for face in faces if faces is not None else []:
            x, y, w, h = [int(value) for value in face[:4]]
            if w < 30 or h < 30:
                continue
            aligned = recognizer.alignCrop(image, face)
            vector = recognizer.feature(aligned).flatten().astype(np.float32)
            vector /= max(float(np.linalg.norm(vector)), 1e-10)
            crop = image[max(0, y):min(height, y + h), max(0, x):min(width, x + w)]
            if crop.size == 0:
                continue
            crop = cv2.resize(crop, (112, 112))
            encoded = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 82])[1]
            results.append((vector, base64.b64encode(encoded).decode("ascii")))
        return results

    cache_path = Path(__file__).parent / ".workbench-data" / "face-library" / "embeddings.npz"
    cached = {}
    if cache_path.is_file():
        try:
            with np.load(cache_path, allow_pickle=False) as cache:
                for path, mtime, size, vector, valid in zip(cache["paths"], cache["mtimes"], cache["sizes"], cache["vectors"], cache["valid"]):
                    cached[str(path)] = (int(mtime), int(size), vector, bool(valid))
        except (OSError, KeyError, ValueError):
            cached = {}

    reference_names = []
    reference_vectors = []
    invalid_references = []
    new_cache = {}
    cache_changed = False
    for item in request["references"]:
        path = item["path"]
        try:
            stat = Path(path).stat()
        except OSError:
            invalid_references.append(item["name"])
            continue
        entry = cached.get(path)
        if entry is None or entry[:2] != (stat.st_mtime_ns, stat.st_size):
            cache_changed = True
            faces = faces_in(path)
            entry = (stat.st_mtime_ns, stat.st_size,
                     faces[0][0] if len(faces) == 1 else np.zeros(128, dtype=np.float32), len(faces) == 1)
        new_cache[path] = entry
        if entry[3]:
            reference_names.append(item["name"])
            reference_vectors.append(entry[2])
        else:
            invalid_references.append(item["name"])

    if cache_changed or new_cache.keys() != cached.keys():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_suffix(".tmp")
        with open(temp_path, "wb") as output:
            np.savez(output, paths=np.array(list(new_cache)),
                     mtimes=np.array([entry[0] for entry in new_cache.values()], dtype=np.int64),
                     sizes=np.array([entry[1] for entry in new_cache.values()], dtype=np.int64),
                     vectors=np.array([entry[2] for entry in new_cache.values()], dtype=np.float32).reshape(-1, 128),
                     valid=np.array([entry[3] for entry in new_cache.values()], dtype=bool))
        os.replace(temp_path, cache_path)

    if request.get("indexOnly"):
        print(json.dumps({"indexed": len(reference_names), "invalidReferences": invalid_references}))
        return

    reference_matrix = np.array(reference_vectors, dtype=np.float32).reshape(-1, 128)

    groups = []
    for frame in request["frames"]:
        for vector, image in faces_in(frame["path"]):
            group = next((group for group in groups if float(np.dot(group["vector"], vector)) >= 0.40), None)
            if group is None:
                group = {"vector": vector, "times": [], "image": image,
                         "scores": np.full(len(reference_names), -1, dtype=np.float32)}
                groups.append(group)
            else:
                group["vector"] += vector
                group["vector"] /= max(float(np.linalg.norm(group["vector"])), 1e-10)
            group["times"].append(frame["time"])
            if len(reference_names):
                group["scores"] = np.maximum(group["scores"], reference_matrix @ vector)

    output = []
    for group in groups:
        matches = {}
        for name, score in zip(reference_names, group["scores"]):
            matches[name] = max(matches.get(name, -1), float(score))
        output.append({
            "image": group["image"],
            "times": sorted(set(group["times"])),
            "matches": [{"name": name, "score": round(score, 3)} for name, score in
                        sorted(matches.items(), key=lambda item: item[1], reverse=True)[:3]],
        })
    output.sort(key=lambda item: item["matches"][0]["score"] if item["matches"] else 0, reverse=True)
    print(json.dumps({"groups": output, "invalidReferences": invalid_references,
                      "framesChecked": len(request["frames"])}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
