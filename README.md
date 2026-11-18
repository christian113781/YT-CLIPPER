# YouTube Clip Finder

Finds the best clip ranges in a YouTube video (normal videos and finished live streams).

Click **⭐ Find best clips**. One scan reads everything and builds a top-10 list of clips, each with a start and end time.

## What it checks
- **Comments and replies**: timestamps people keep writing ("1:03 💀"), weighted by likes and by how many replies the comment got. Replies are read for the 40 most-discussed threads.
- **Quotes**: a comment with no timestamp that quotes a line from the video is matched to where that line is said in the transcript.
- **Transcript**: clips start and end on caption lines, hype words and [Laughter]-style tags add score, and each clip shows a text preview.
- **Live chat replay** (finished streams): spikes where chat spams. A spike right after a commented moment counts as the same moment.
- **Most replayed** graph: boosts clips on a replay peak.

Clips are 15-60s. Chapter-list comments are ignored. Overlapping clips keep only the better one.
The line under the heat bar shows which signals were available for the video.

Long streams with busy chat can take a few minutes; **Stop & show results** ranks with what was read so far.

## Install
1. Unzip this folder.
2. Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**.
3. Click **Load unpacked** and select the `yt-clip-finder` folder.
4. Open any YouTube video and click the toolbar icon or the red **🔥 Clip Finder** button.
