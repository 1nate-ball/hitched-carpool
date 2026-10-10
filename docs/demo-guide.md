# Demo recording (under two minutes)

Record the browser window at http://127.0.0.1:8000. On Mac, press Cmd+Shift+5 and choose Record Selected Portion. Include only the app and browser toolbar so the refresh is visible.

1. **0–10 seconds:** Show the profile. Say: “This is Hitch, a BYU student carpool app. Our vertical slice saves a student's profile to a real SQLite database.”
2. **10–30 seconds:** Click Edit profile, change hometown and bio, and choose an avatar color. Say: “I'll change the hometown and short bio.”
3. **30–45 seconds:** Click Save changes and show the updated profile. Say: “Save changes sends a request to our Python backend, updates the Users table, and displays the saved response.”
4. **45–60 seconds:** Refresh with Cmd+R / Ctrl+R and point out the same values. Say: “After refreshing, those values are loaded from the database and remain saved.”
5. Stop the recording. Upload it to a video host or Drive with anyone-with-link viewing enabled. Test the link in a private window.

## GitHub setup if starting from the downloadable folder

Create a new **public** repository named `hitched-carpool` at https://github.com/new. Leave automatic README, license, and .gitignore creation unchecked. From the project folder:

```sh
git init -b main
git add .
git commit -m "Build persistent profile vertical slice and document data model"
git remote add origin https://github.com/1nate-ball/hitched-carpool.git
git push -u origin main
```

Use GitHub's recommended authentication when prompted. Never paste tokens into source files. Invite teammates through Settings → Collaborators after uploading.

## Submission text

Demo video: PASTE_PUBLIC_VIDEO_LINK_HERE

README: https://github.com/1nate-ball/hitched-carpool#readme

Replace the repository link if the team uses another repository. Do not submit until the video is uploaded and both links open without signing in.
