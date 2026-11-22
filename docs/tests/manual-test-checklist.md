# Manual test checklist

After installing the zips, check these 7 items. Each takes about a minute.

1. **Tall page** - Open a 20,000px tall article, set browser zoom to 200%
   (simulates DPR 2), take a Full Page screenshot. **Pass:** the file is
   created.
2. **Shortcuts** - On a normal page press Ctrl+Shift+S, Ctrl+Shift+X,
   Ctrl+Shift+E, Alt+Shift+E. **Pass:** the same action as the buttons.
3. **Rebind** - Change one shortcut at `chrome://extensions/shortcuts` and
   press it again. **Pass:** the new key works.
4. **Ask for filename** - Turn on "Ask for filename" in Settings, download
   an image, rename it in the dialog. **Pass:** saved under the new name.
5. **Show in folder** - From History, use "Show in folder" on a download.
   **Pass:** the folder opens.
6. **ZIP cancel** - Start a 200-image ZIP, press Cancel in the popup.
   **Pass:** no zip file is created and memory drops back.
7. **Google Lens** - Right-click an image, choose Search Image with Google
   Lens. **Pass:** the Google Lens results page opens for that image, in
   both Chrome and Edge.

If anything fails, report which item and the exact error message.

## Firefox

Firefox is in development, not released. Install only as a temporary add-on for testing: open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on, and select the Firefox zip or `manifest.json` inside `dist/firefox-staging/`. A temporary add-on is removed when Firefox restarts, so reload it after a restart. Record the Firefox version and the platform for every item below. See [the Firefox document](../firefox.md) for the compatibility matrix and for every item still marked as needing a manual test in Firefox.

1. **Install from the zip** - Load the Firefox zip as a temporary add-on. **Pass:** the extension loads with no install error, the toolbar button appears, and the popup opens.
2. **Host permission, grant path** - On the welcome page (step 0), use the host access row button to grant access to websites. Repeat on the options page, About section, after revoking access if the browser allows it. **Pass:** the row hides on grant, and scanning and saving from other pages work after grant.
3. **Host permission, deny path** - Decline the host access request on the welcome page, then check the options page About row. **Pass:** the row stays with denied text, the extension does not crash, and toolbar button and menu actions on the current page still work, while scanning and saving from other pages are reported as needing the permission.
4. **Scan page** - Scan a normal page with images, including a page with frames. **Pass:** results appear, counts match the page, and filtering and sorting work.
5. **Select and download images** - Select one image and several images, then download them. **Pass:** each file is saved with the expected name and folder behavior, and history records each download.
6. **ZIP download** - Start a multi-image ZIP download and let it finish, then start another and cancel it. **Pass:** the finished ZIP contains every selected image, and the cancelled ZIP creates no file.
7. **Smart Download from the context menu** - Right-click an image and use Smart Download, and repeat from the page context menu. **Pass:** the best available version is saved, and a repeat run gives the same result.
8. **Format conversion** - Download the same image as PNG, JPG, and WebP, then request AVIF. **Pass:** each format saves with the correct type, and the AVIF case shows the browser-neutral message ("AVIF encoding is not available in this browser. A PNG was saved instead.") in English, with a PNG saved instead. Note: the other 20 locales still carry the old Chrome and Edge wording, which is a known locale pass follow-up, so check the English wording here and record any other locale result separately.
9. **Screenshot modes** - Take a Visible screenshot, an Area screenshot, an Element screenshot, and a Full Page screenshot. **Pass:** each mode saves the expected image, Area and Element captures match the selected region, and the editor opens where expected.
10. **Very long full-page capture with Parts overview** - Take a Full Page screenshot of a very long page that splits into parts, then open the Parts overview. **Pass:** every part is present, per-part Edit, Save, Copy, and Discard work, and the stitched result is complete with no missing or duplicated band. Also note whether a long job survives an event-page idle cycle, since long-job idle survival is untested.
11. **Editor** - In the annotation editor, draw, crop, undo, redo, Copy, and Save. **Pass:** strokes and crop behave as in Chrome, undo and redo step through strokes and crop together, Copy puts the image on the clipboard, and Save writes the cropped result.
12. **Clipboard copy** - Copy an image from the editor, from the popup, and from the context menu, including a large image that needs downscaling. **Pass:** each copy pastes as an image, and the large image copy succeeds within the downscale budget.
13. **Notifications** - Trigger two notifications in quick succession, for example two completed downloads. **Pass:** notifications appear with the ImgFetch icon and title, and rapid successive notifications are recorded honestly if any is dropped.
14. **Keyboard shortcuts, including Firefox candidates** - On a normal page press Alt+Shift+S, Ctrl+Shift+X, Alt+Shift+E, and Alt+Shift+C, and confirm the two changed defaults (Alt+Shift+S for scan page, Alt+Shift+C for capture element) plus the two unchanged defaults (Ctrl+Shift+X, Alt+Shift+E). **Pass:** each key runs the same action as its button, and any candidate that does nothing is recorded as a failed press test, not assumed free. Also test rebinding one shortcut in Manage Extension Shortcuts and pressing the new key.
15. **Options page** - Open Settings from the popup, from the toolbar menu, and through the options page hash link to the sites section. Change a setting, reload the extension, and check the setting again. **Pass:** the options page opens every time, the hash navigation lands on the sites section, and settings persist.
16. **Language switch including Arabic RTL** - Switch the language to Arabic and to at least one other locale, including a locale with a variant code such as es_419 or zh_CN where available. **Pass:** the UI switches language, Arabic renders right to left with no clipped controls, and variant locale fallback is recorded honestly if a parent locale is used instead.

If anything fails, report which item, the Firefox version and platform, and the exact error message.
