FillPilot - setup on a Windows PC
==================================

Nothing is installed. FillPilot runs from this folder, as you, on this PC only.
You do not need Node.js, a database or administrator rights.
Nothing is stored: no database, and no bills are kept.

Needs: Windows 10 or 11, Google Chrome.


1. Put the folder somewhere permanent
   Unzip the whole "FillPilot" folder, for example to  C:\FillPilot  or to your
   Documents. Do not run it from inside the zip.

2. Start it
   Double-click  "FillPilot-Start.cmd".
   When the window says

       FillPilot is running.
       Reading scanned bills: working

   it is ready. Keep that window open while you work. Closing it stops FillPilot.

   If Windows shows "Windows protected your PC", click "More info" and then
   "Run anyway" (this appears once, because the file came from another PC).

3. Add FillPilot to Chrome (once)
   - In Chrome, open   chrome://extensions
   - Turn on "Developer mode" (top right).
   - Click "Load unpacked" and choose the  "extension"  folder inside this folder.
   - Click the puzzle icon in Chrome's toolbar and pin FillPilot.

4. Use it
   - Open the bill on  https://essp.tgnpdcl.com  (medical bill entry).
   - Click the FillPilot icon. The panel opens at the side.
   - Sign in:  admin / admin
     (To choose your own password, click "Change password" on the sign-in screen.)
   - Click "Enable" for the website when the panel asks (once).
   - Drop the patient's final bill and summary bill PDFs into the panel.
   - For each tab press "Fill this tab", check what was entered, then go on.

   FillPilot fills and presses Next only. It never saves, submits or ticks
   the declarations - you check everything and submit yourself.
   The bill is not stored: it stays in the browser until you press
   "Finished - clear this bill", sign out, or close Chrome.


Every day
---------
   Start:  double-click "FillPilot-Start.cmd" and leave the window open.
   Stop:   close that window (or double-click "FillPilot-Stop.cmd").


If something does not work
--------------------------
   The panel says "FillPilot is not running on this PC"
        Start it (step 2) and try again.

   "Reading scanned bills: NOT WORKING"
        This PC's Windows cannot run the text reader FillPilot uses (the one
        built into Windows). Send the line shown to your support contact.

   A tab was not filled correctly
        In the panel, click "Export activity log" (at the bottom) and send the
        saved file to your support contact. It lists which steps ran and why
        one failed. It contains no patient details.

   The window says a PROBLEM
        Send the file  data\logs\server.log  to your support contact.

   Nothing happens / "This app has been blocked"
        Your PC only allows approved programs. Ask your IT team to allow the
        FillPilot folder, or FillPilot has to run on another PC.

   Forgot the password
        Remove FillPilot in chrome://extensions and add it again (step 3).
        The sign-in is then admin / admin again.

   Remove FillPilot
        Stop it, remove the extension in chrome://extensions, delete this folder.
