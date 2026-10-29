# Keashur Meet

Multi-user video calls, screen sharing, a shared whiteboard and file sharing.

## Run
    npm install
    npm start

Open http://localhost:3000, register two accounts, and join the same room name.

The login API and video-call signalling run on the Node.js server. Do not open `index.html` directly or host this app as a static GitHub Pages site; those options do not run the backend and login will fail. For deployment, host the Node.js app on a server that supports persistent processes and HTTPS, and set a stable `JWT_SECRET` in its environment.

## Layout
- `server.js`: Express + Socket.io. Auth (bcrypt + JWT), SQLite, uploads, signalling, whiteboard sync.
- `app.js`: WebRTC mesh, screen share (`replaceTrack`), whiteboard canvas, file UI.

## Security notes
- Media: WebRTC encrypts all audio/video with DTLS-SRTP, always on.
- Everything else (signalling, whiteboard, files, login): needs HTTPS in deployment. Browsers only allow camera access on HTTPS or localhost.
- Passwords are bcrypt-hashed; sessions are 12-hour JWTs; sockets and downloads require a valid token; auth routes are rate limited.
- This is transport encryption, not end-to-end for files or whiteboard: the server can read those.

## Known limits / next steps
- Mesh topology is fine up to about 6-8 people. Beyond that, move to an SFU (mediasoup, LiveKit).
- Add a TURN server (coturn) in `ICE` for users behind strict NATs.
- Uploaded files stay on disk; add expiry/cleanup. Add chat and room passwords as extensions.
