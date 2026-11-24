# ImgFetch manual frame-time check (G5)

Why this document exists: the worst-frame target is 20 ms, but it cannot
be proven under Xvfb. The virtual display renders in software, so the
200-row history measured 100 ms worst there, which says nothing about a
real machine. The check below is the manual replacement: run it on a real
machine, in real Chrome, and record the numbers.

## Target

Worst frame at or under 20 ms, on the views below, with no CPU throttling
and again with 4x CPU slowdown if you want a weak-machine reading. A
single frame over 20 ms while scrolling or opening a view fails the
target for that run. Note the run conditions next to the number, because
a throttled run and an unthrottled run are not comparable.

## Views to measure

1. Popup home view with the history section open (200 or more rows).
2. Options page, Download History section (same 200 or more rows).
3. Popup results grid with 200 or more images, while scrolling.

## Steps

1. Load the unpacked extension in Chrome on a real machine (not a VM
   with a virtual display). Close other heavy tabs first.
2. Build the 200-row history first: run a few scans and downloads, or
   restore a profile that already has 200 or more history rows. The row
   count matters, so record it.
3. Open the view to measure. For the popup, right-click the ImgFetch
   toolbar icon and choose Inspect popup to open DevTools on the popup
   itself. For the options page, open it normally and press F12.
4. In DevTools, open the Performance tab. Turn off any CPU throttling
   for the first run (the throttling control is the gear menu in the
   Performance tab). Check that "Enable advanced paint instrumentation"
   is off; it slows the run and is not needed here.
5. Click the record circle, then do one thing only: either open the
   history section, or scroll the list from top to bottom at a steady
   speed for about 5 seconds. Then stop the recording.
6. Read the result. In the Frames track, each frame is a bar; the
   height is its duration. Hover the tallest bar to read its time in
   milliseconds. That is the worst frame for the run. Also note the
   longest task in the Main track, since a long task is usually what
   makes a frame long.
7. Repeat step 5 twice more on the same view and keep the worst of the
   three runs. First paint after opening can be slower than steady
   scrolling, so record the open and the scroll runs separately.
8. Optional weak-machine run: set CPU throttling to 4x slowdown in the
   Performance tab and repeat steps 5 to 7. Label it as throttled.

## What to record

Copy this block per run and fill it in:

- Machine and Chrome version:
- View (popup history / options history / results grid):
- History rows or result images:
- CPU throttling (none / 4x):
- Reduced motion on or off (the OS setting; on neutralises animations):
- Worst frame, open (ms):
- Worst frame, scroll (ms):
- Longest task (ms) and what it was (from the Main track):
- Verdict (pass at or under 20 ms, or fail with the number):

## Notes

- The popup is 400 px wide by design, so measure it at its real size;
  do not resize the DevTools window to force a wider popup.
- If a run shows a single long frame at the very start, that is usually
  the first paint after opening, not scroll jank. Record it under
  "worst frame, open" and keep scrolling frames separate.
- A throttled run is a stress check, not the pass bar. The 20 ms
  target applies to the unthrottled run on a real machine.
- The automated motion checks in tests/test-motion.mjs still cover the
  token scale, the forbidden properties and the reduced-motion rules;
  they do not measure frame time, which is why this manual check exists.
