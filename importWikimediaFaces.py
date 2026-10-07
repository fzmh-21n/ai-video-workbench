"""Import one traceable Commons portrait per well documented Chinese actor or singer."""

import concurrent.futures
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).parent
LIBRARY = ROOT / ".workbench-data" / "face-library"
INDEX = LIBRARY / "index.json"
MODELS = ROOT / ".workbench-data" / "face-models"
HEADERS = {"User-Agent": "CodexFaceScreen/0.1 (local desktop reference library)"}
QUERY = """SELECT DISTINCT ?person ?personLabel ?simpleName ?image ?sitelinks ?article ?country WHERE {
  VALUES ?occupation { wd:Q33999 wd:Q177220 }
  VALUES ?country { wd:Q148 wd:Q8646 wd:Q865 wd:Q833 wd:Q334 }
  ?person wdt:P106 ?occupation; wdt:P27 ?country; wdt:P18 ?image;
          wikibase:sitelinks ?sitelinks.
  FILTER(?sitelinks >= 5)
  OPTIONAL { ?article schema:about ?person; schema:isPartOf <https://zh.wikipedia.org/>. }
  OPTIONAL { ?person rdfs:label ?simpleName. FILTER(LANG(?simpleName) = "zh-hans") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en". }
} ORDER BY DESC(?sitelinks)"""
CURATED = [
    ("王一博", "File:王一博.jpg"),
    ("迪丽热巴", "File:Dilraba Dilmurat 迪麗熱巴.jpg"),
    ("赵丽颖", "File:Zhao Liying at Chinese Restaurant S4 Announcement Conference, 31 July 2020 (cropped).jpg"),
    ("刘诗诗", "File:Liu ShiShi in 2024 (cropped).jpg"),
    ("王鹤棣", "File:Dylan Wang.jpg"),
    ("陈都灵", "File:Chen Duling in 2018.png"),
    ("刘宇宁", "File:刘宇宁 Liu Yuning 综艺 2020.jpg"),
    ("李连杰", "File:Jet Li 2009 (cropped).jpg"),
    ("巩俐", "File:Gong Li Cannes 2016 (cropped).jpg"),
    ("张国荣", "File:Leslie Cheung (cropped).jpg"),
    ("李玟", "File:CoCo Lee at Shanghai 2013718 (cropped).jpg"),
    ("元彪", "File:Yuenbiao.png"),
    ("萨顶顶", "File:Sa Dingding (cropped).jpg"),
    ("高以翔", "File:Godfrey Gao (9352300977) (cropped).jpg"),
    ("宋茜", "File:Victoria Song in January 2024.png"),
    ("虞书欣", "File:Yu Shuxin in 2025 (2).jpg"),
]


def get(url, timeout=30, attempts=3):
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))


def get_json(url, params):
    return json.loads(get(url + "?" + urllib.parse.urlencode(params)).decode("utf-8"))


def candidates():
    data = get_json("https://query.wikidata.org/sparql", {"query": QUERY, "format": "json"})
    people = {}
    for row in data["results"]["bindings"]:
        qid = row["person"]["value"].rsplit("/", 1)[-1]
        if qid in people:
            continue
        image = urllib.parse.unquote(row["image"]["value"].rsplit("/", 1)[-1])
        article = row.get("article", {}).get("value", "")
        name = urllib.parse.unquote(article.rsplit("/", 1)[-1]).replace("_", " ") if article else row["personLabel"]["value"]
        name = re.sub(r"\s*\([^)]*\)$", "", name)
        name = row.get("simpleName", {}).get("value", name)
        country = row["country"]["value"].rsplit("/", 1)[-1]
        if country in {"Q833", "Q334"} and (not article or not re.fullmatch(r"[\u3400-\u9fff\s]+", name)):
            continue
        people[qid] = {"id": qid, "name": name,
                       "fileTitle": "File:" + image, "sitelinks": int(row["sitelinks"]["value"])}
    result = list(people.values())
    result.extend({"id": "curated-" + str(index), "name": name,
                   "fileTitle": title, "sitelinks": 0}
                  for index, (name, title) in enumerate(CURATED))
    return result


def commons_info(batch):
    data = get_json("https://commons.wikimedia.org/w/api.php", {
        "action": "query", "format": "json", "prop": "imageinfo", "iiprop": "url|extmetadata",
        "iiurlwidth": 500, "iiextmetadatafilter": "LicenseShortName|LicenseUrl",
        "titles": "|".join(person["fileTitle"] for person in batch),
    })
    return {page["title"]: page["imageinfo"][0]
            for page in data["query"]["pages"].values() if page.get("imageinfo")}


def photo(info):
    image = cv2.imdecode(np.frombuffer(get(info["thumburl"], timeout=12, attempts=2), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    detector = cv2.FaceDetectorYN.create(str(MODELS / "face_detection_yunet_2023mar.onnx"), "",
                                        (image.shape[1], image.shape[0]), 0.8)
    _, faces = detector.detect(image)
    if faces is None or len(faces) != 1 or faces[0][2] < 30 or faces[0][3] < 30:
        return None
    return cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes()


def main():
    if not (MODELS / "face_detection_yunet_2023mar.onnx").is_file():
        sys.exit("请先运行 setup-face-screen.ps1")
    LIBRARY.mkdir(parents=True, exist_ok=True)
    entries = json.loads(INDEX.read_text("utf-8")) if INDEX.exists() else []
    known_ids = {entry.get("wikidataId") for entry in entries}
    known_names = {entry["name"] for entry in entries}
    people = candidates()
    names_by_id = {person["id"]: person["name"] for person in people}
    for entry in entries:
        if entry.get("wikidataId") in names_by_id:
            entry["name"] = names_by_id[entry["wikidataId"]]
    known_names = {entry["name"] for entry in entries}
    INDEX.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    if sys.argv[1:] == ["--curated-only"]:
        people = [person for person in people if person["id"].startswith("curated-")]
    print(f"候选 {len(people)} 人；已有 {len(entries)} 张参考图", flush=True)
    added = 0
    failed = 0
    for start in range(0, len(people), 50):
        batch = [person for person in people[start:start + 50]
                 if person["id"] not in known_ids and person["name"] not in known_names]
        if not batch:
            continue
        try:
            info_by_title = commons_info(batch)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                print("来源站点已限流，暂停导入；已完成的照片保留在本机", flush=True)
                break
            print(f"来源信息第 {start // 50 + 1} 批失败：{error}", flush=True)
            failed += len(batch)
            continue
        except Exception as error:
            print(f"来源信息第 {start // 50 + 1} 批失败：{error}", flush=True)
            failed += len(batch)
            continue
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            jobs = {}
            rate_limited = False
            for person in batch:
                info = info_by_title.get(person["fileTitle"])
                metadata = info.get("extmetadata", {}) if info else {}
                if not info or not info.get("thumburl") or not metadata.get("LicenseShortName"):
                    failed += 1
                    continue
                jobs[pool.submit(photo, info)] = (person, info, metadata)
            for job in concurrent.futures.as_completed(jobs):
                person, info, metadata = jobs[job]
                try:
                    image = job.result()
                except urllib.error.HTTPError as error:
                    if error.code == 429:
                        rate_limited = True
                    image = None
                except Exception:
                    image = None
                if image is None:
                    failed += 1
                    continue
                filename = person["id"] + ".jpg"
                (LIBRARY / filename).write_bytes(image)
                entries.append({"id": person["id"], "wikidataId": person["id"] if person["id"].startswith("Q") else "",
                                "name": person["name"], "file": filename,
                                "sourceUrl": info["descriptionurl"],
                                "license": metadata["LicenseShortName"]["value"],
                                "licenseUrl": metadata.get("LicenseUrl", {}).get("value", ""),
                                "sitelinks": person["sitelinks"]})
                known_ids.add(person["id"])
                known_names.add(person["name"])
                added += 1
        INDEX.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已处理 {min(start + 50, len(people))}/{len(people)}；新增 {added}；跳过 {failed}", flush=True)
        if rate_limited:
            print("来源站点已限流，暂停导入；已完成的照片保留在本机", flush=True)
            break
    print(f"完成：新增 {added}，参考图总数 {len(entries)}，跳过 {failed}")


if __name__ == "__main__":
    main()
