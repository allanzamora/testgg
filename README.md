# Moviex multiplayer server - Node.js version (works in Termux)

## Run it on your phone (Termux)
    pkg update
    pkg install nodejs
    cd moviex-node          (the folder you unzipped)
    npm install
    node server.js

Then open  http://localhost:8080  in your phone browser, press Connect, move with the keyboard
(on a phone, tap or drag on the canvas to walk).
Friends on the SAME Wi-Fi can open  http://YOUR-PHONE-IP:8080  (find it with `ifconfig` in Termux).

## Put it on the internet for free (no command line needed)
1. Upload this folder to a new GitHub repository (you can do it from the GitHub website on your phone).
2. On https://render.com create a free account -> New -> Web Service -> pick the repo.
   Build command: npm install     Start command: node server.js     Instance type: Free
3. When it is live, open the https://....onrender.com address in two phones/tabs and press Connect.
Free Render services sleep after 15 idle minutes (a new connection wakes them in about a minute).
