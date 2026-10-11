import { IpcMainInvokeEvent } from "electron";
import { get } from "https";

const ALLOWED_HOSTS = new Set([
    "yt3.googleusercontent.com",
    "lh3.googleusercontent.com",
    "i.ytimg.com"
]);

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export async function fetchArtwork(
    _: IpcMainInvokeEvent,
    url: string
): Promise<string | null> {
    let parsedUrl: URL;

    try {
        parsedUrl = new URL(url);
    } catch {
        return null;
    }

    if (
        parsedUrl.protocol !== "https:" ||
        !ALLOWED_HOSTS.has(parsedUrl.hostname)
    ) {
        return null;
    }

    return new Promise((resolve, reject) => {
        const request = get(parsedUrl, response => {
            const status = response.statusCode ?? 0;

            if (
                status >= 300 &&
                status < 400 &&
                response.headers.location
            ) {
                response.resume();

                const redirectUrl = new URL(
                    response.headers.location,
                    parsedUrl
                ).toString();

                fetchArtwork(_, redirectUrl).then(resolve, reject);
                return;
            }

            if (status !== 200) {
                response.resume();
                reject(new Error(`Artwork request failed: HTTP ${status}`));
                return;
            }

            const chunks: Buffer[] = [];
            let totalSize = 0;

            response.on("data", (chunk: Buffer) => {
                totalSize += chunk.length;

                if (totalSize > MAX_IMAGE_SIZE) {
                    request.destroy(
                        new Error("Artwork exceeded maximum allowed size.")
                    );
                    return;
                }

                chunks.push(chunk);
            });

            response.on("end", () => {
                const contentType =
                    response.headers["content-type"] ?? "image/jpeg";

                const base64 = Buffer.concat(chunks).toString("base64");

                resolve(`data:${contentType};base64,${base64}`);
            });
        });

        request.on("error", reject);
    });
}