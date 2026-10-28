PIB vs ZPX Live Cricket - deployment guide (Docker + Postgres, Dokploy)
=====================================================================

Files
  public/index.html          the whole website (live score, scorecard, awards, results, scorer)
  server.js                  serves the site, stores the score in Postgres, pushes live updates
  Dockerfile                 builds the "app" image (Node 22)
  docker-compose.yml         app + Postgres; this is the file Dokploy deploys
  docker-compose.local.yml   local testing only: publishes the app on localhost
  .env.example               every setting, with explanations

How it fits together
  app  (Node, port 3000)  --private "backend" network-->  db (postgres:17, port 5432)
  Postgres data lives in the named volume "pgdata", so redeploys keep every match.
  The db is not published to the internet; only the app can reach it.
  Viewers get each ball instantly over Server-Sent Events (/api/stream).
  Only the scorer (SCORER_EMAIL / SCORER_PASSWORD) can change the score.
  Tables are created automatically on first start.

----------------------------------------------------------------------
1. PUT THE CODE IN A GIT REPOSITORY
----------------------------------------------------------------------
 Dokploy builds the image from source, so push this folder to its own
 GitHub / GitLab / Gitea repository (.env is git-ignored, keep it that way).

----------------------------------------------------------------------
2. DOKPLOY
----------------------------------------------------------------------
 a. Dokploy > your project > Create Service > Compose.
    Source: your repository and branch. Compose path: ./docker-compose.yml
    Compose type: Docker Compose.
 b. Environment tab: paste the contents of .env.example and change the values:
      POSTGRES_PASSWORD   long random password
      SCORER_EMAIL        the scorer's login email
      SCORER_PASSWORD     the scorer's password
      SESSION_SECRET      run: openssl rand -hex 32
    Save. (Deploy fails with "Set ..." if a required value is missing.)
 c. Domains tab > Add domain:
      Service name: app     Container port: 3000
      Host: e.g. cricket.yourdomain.com   HTTPS: on, certificate: Let's Encrypt
    Point that host's DNS A record at the Dokploy server's IP.
 d. Deploy. Watch the logs for "Cricket live listening on :3000".
    Check https://cricket.yourdomain.com/healthz returns {"ok":true}.
 e. Optional: Advanced > enable "Isolated Deployment" (Dokploy then handles the
    network wiring itself). Optional: Volume Backups on the "pgdata" volume.

 To update: push to the branch and press Deploy (or turn on Auto Deploy).
 Postgres keeps its data across deploys. Do NOT delete the pgdata volume unless
 you mean to wipe every match.
 Note: POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB are only applied when the
 volume is first created. To change the password later, change it inside
 Postgres too (ALTER USER cricket PASSWORD '...').

----------------------------------------------------------------------
3. RUN IT LOCALLY (optional)
----------------------------------------------------------------------
   cp .env.example .env        (then edit the values)
   docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
   open http://localhost:3000  (APP_PORT in .env changes the port)
 Stop: docker compose down     Wipe the local database too: docker compose down -v

----------------------------------------------------------------------
4. OPTIONAL: SAVE EACH MATCH TO GOOGLE DRIVE
----------------------------------------------------------------------
 After "Save result", the site creates a Google Doc scorecard in a Drive folder
 called DRIVE_FOLDER_NAME (made on the first save) in the Google account the
 scorer signs in with.
 a. https://console.cloud.google.com > create or select a project.
 b. APIs & Services > Library > "Google Drive API" > Enable.
 c. APIs & Services > OAuth consent screen > External > fill app name + your email
    > Scopes: add .../auth/drive.file > Test users: add the scorer's Google email.
 d. APIs & Services > Credentials > Create credentials > OAuth client ID
    > Web application > Authorized JavaScript origins:
      https://cricket.yourdomain.com   (your Dokploy domain)
    > Create, copy the Client ID.
 e. Dokploy > Environment: GOOGLE_CLIENT_ID=<that client id>, then Deploy.
 Leave GOOGLE_CLIENT_ID empty to keep the Drive feature switched off.

----------------------------------------------------------------------
5. MATCH DAY
----------------------------------------------------------------------
 - Share the site link: anyone can watch, no login needed.
 - Scorer: open the link > Scorer login > set toss and playing XI (max 11 each)
   > score ball by ball on ONE phone.
 - After the match: Save result. Google may ask the scorer to sign in to Drive.
 - Test a few balls before the day, then More options > Clear match.

Notes
 - Run a single replica of "app": live updates are pushed from the app's memory.
 - The scorer stays logged in for 30 days. Changing SCORER_PASSWORD or
   SESSION_SECRET (and redeploying) logs the scorer out everywhere.
 - 10 wrong passwords from one address locks login for 15 minutes.
 - The Google Client ID is not a secret; the scorer login is what protects the score.
