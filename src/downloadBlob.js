export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let link;
  try {
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    // Give the browser time to claim the file, then release it before the next video.
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  } finally {
    link?.remove();
    URL.revokeObjectURL(url);
  }
}
