# Install on Oracle Cloud Always Free, no domain

The smallest deployment that still runs the whole app: one free ARM virtual machine, the dashboard
reachable only through an SSH tunnel, nightly encrypted backups to object storage, and two uptime
checks. No domain, no public port, no TLS to manage.

Cost: $0 for compute and network on the Always Free tier, plus whatever Anthropic spends, which the
app caps at USD 50 a month. Read [backups.md](backups.md) before you run the first backup.

## What you need first

| Item                                                                     | Where                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Oracle Cloud account with Always Free available                          | `cloud.oracle.com`                                        |
| Google OAuth client, id and secret                                       | Google Cloud console, OAuth client type "Web application" |
| Anthropic API key                                                        | Anthropic console                                         |
| A Gmail app password for the notification address                        | Google account, 2-step verification, app passwords        |
| An age identity, generated on your laptop and never copied to the server | `age-keygen -o ~/eve-backup-identity.txt`                 |
| A Cloudflare R2 bucket and its S3 credentials                            | Cloudflare dashboard                                      |

## 1. The instance

Create a compute instance with:

- Image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**, **4 OCPU** and **24 GB** memory.
- Boot volume **200 GB**.
- Your SSH public key.
- Security list with **only** port 22 open. Do not open 80 or 443.

"Out of host capacity" is common. Try another availability domain, then another region. If it keeps
failing, take the same steps on a Hetzner CX22 and continue at step 3.

## Automated path

Steps 2 to 7, plus the timers, are scripted. After the instance exists and `.env` is filled in:

```sh
scripts/ops/deploy.sh ubuntu@<instance-ip> --dry-run   # prints what it would do
scripts/ops/deploy.sh ubuntu@<instance-ip>
```

It refuses a `.env` with placeholder or empty required values, rsyncs the checkout without `.git`
or `epics/`, copies `.env` with mode 600, installs Docker and the firewall rules, starts the stack,
waits for `/v1/health`, and installs the backup and health timers. The manual steps below are the
same work done by hand.

Set `RCLONE_REMOTE`, `HOST_BACKUP_CHECK_URL` and `HOST_API_CHECK_URL` in the server environment
(`/etc/environment` or an `EnvironmentFile`) before running it if you want the off-box copy and the
uptime pings wired automatically.

## 2. Base software

```sh
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in
sudo ufw allow 22/tcp && sudo ufw --force enable
docker version && docker compose version
```

## 3. The code and the environment

```sh
git clone https://github.com/Sambalicious/eve.git ~/eve
cd ~/eve
cp .env.example .env
chmod 600 .env
```

Set these in `.env`. Everything else in the file already has a working default for this shape.

```sh
PUBLIC_ORIGIN=http://localhost:3000
API_HOST_PORT=3000
SUBMISSION_BROWSER_ENABLED=0
CANDIDATE_GOOGLE_SUB=<your Google subject id>
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
ANTHROPIC_API_KEY=<key>
SMTP_USER=<gmail address>
SMTP_PASSWORD=<app password>
BACKUP_AGE_RECIPIENT=<age public key from your laptop>
BACKUP_DIR=/home/ubuntu/eve-backups
```

`PUBLIC_ORIGIN` is `http://localhost:3000` on purpose. The browser sees the tunnel as localhost, so
cookies and the OAuth redirect match. The API and Postgres already bind to `127.0.0.1`, so nothing is
listening publicly even before the firewall.

## 3b. A stable public URL with Tailscale Funnel

Optional, and the cheapest way to have a real HTTPS address before buying a domain.

What you do once in the Tailscale admin console: enable **HTTPS certificates** on the DNS page, and
allow **Funnel** in the access rules. Then, on the server:

```sh
# either join interactively, or pass a key from Settings, Keys
sudo tailscale up
TS_AUTHKEY=tskey-auth-... scripts/ops/enable-funnel.sh
```

The script installs Tailscale if missing, joins the tailnet, runs `tailscale funnel --bg 3000`, writes
`PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net` into `.env`, restarts the api, and prints the exact
OAuth redirect to add. `--status` shows the current Funnel, `--off` turns it off.

The URL survives restarts, so the OAuth redirect stays valid. Funnel publishes on 443 only; the
container ports stay bound to `127.0.0.1`. Anyone with the link can load the landing and sign-in
pages, and the dashboard still requires the one Google account named in `CANDIDATE_GOOGLE_SUB`.

## 4. Google OAuth

In the OAuth client, add an authorised redirect URI:

```
http://localhost:3000/v1/auth/google/callback
```

Add your own Google account as a test user while the app is unverified.

## 5. First start

```sh
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/v1/health
```

Compose runs `provision-roles` and `migrate` before the api and worker start. If the api exits, read
`docker compose logs api`; the usual cause is a missing value in `.env`.

## 6. Reach it from your laptop

```sh
ssh -N -L 3000:127.0.0.1:3000 ubuntu@<instance-ip>
```

Open `http://localhost:3000` and sign in with Google. Chrome and Firefox accept the `__Host-`
session cookie on localhost because they treat it as a secure origin. If you use Safari, or want the
dashboard on your phone, add Tailscale on both machines and use the `*.ts.net` HTTPS name as
`PUBLIC_ORIGIN` and as the OAuth redirect instead.

## 7. Backups that leave the box

Generate the age identity on your laptop, keep it there, and put only the public key in `.env`:

```sh
age-keygen -o ~/eve-backup-identity.txt
age-keygen -y ~/eve-backup-identity.txt   # this is BACKUP_AGE_RECIPIENT
```

Run one on demand backup and check the log ends with `status=ok`:

```sh
sudo -u ubuntu ~/eve/scripts/backup/backup.sh --on-demand
tail -5 ~/eve-backups/backup.log
```

Configure rclone for R2 as the `ubuntu` user, then automate the copy and the health ping:

```sh
rclone config   # new remote "r2", S3 compatible, endpoint https://<account>.r2.cloudflarestorage.com
mkdir -p ~/.config/systemd/user
```

`~/.config/systemd/user/eve-backup.service`

```ini
[Unit]
Description=Eve nightly encrypted backup and off-box copy

[Service]
Type=oneshot
WorkingDirectory=/home/ubuntu/eve
ExecStart=/home/ubuntu/eve/scripts/backup/backup.sh --nightly
ExecStartPost=/usr/bin/rclone sync /home/ubuntu/eve-backups r2:eve-backups --transfers 4
ExecStartPost=/usr/bin/curl -fsS -m 10 https://hc-ping.com/<backup-check-uuid>
```

`~/.config/systemd/user/eve-backup.timer`

```ini
[Unit]
Description=Run the Eve backup at 03:10 daily

[Timer]
OnCalendar=*-*-* 03:10:00
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
loginctl enable-linger ubuntu
systemctl --user daemon-reload
systemctl --user enable --now eve-backup.timer
systemctl --user list-timers | grep eve
```

Set an R2 lifecycle rule of 30 days so the remote matches `BACKUP_RETENTION_DAYS`.

## 8. Uptime checks

Two checks on healthchecks.io, both free:

| Check        | Period           | Signal                              |
| ------------ | ---------------- | ----------------------------------- |
| `eve-backup` | 1 day, grace 2 h | pinged by the backup unit           |
| `eve-api`    | 5 min            | a timer that curls the health route |

`~/.config/systemd/user/eve-health.service`

```ini
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'curl -fsS -m 10 http://127.0.0.1:3000/v1/health >/dev/null && curl -fsS -m 10 https://hc-ping.com/<api-check-uuid>'
```

Pair it with `eve-health.timer` on `OnCalendar=*:0/5`. A dead worker shows up as a missing ping, not
as a quiet day.

## 9. Restore drill, once

Run it on the laptop that holds the identity file, against a copy of the backup set:

```sh
scp ubuntu@<instance-ip>:~/eve-backups/eve-db-*.dump.age .
scripts/backup/restore-drill.sh --identity ~/eve-backup-identity.txt
```

It must exit 0. Until it has, you have backups the same way you have a fire escape painted on a wall.

## 10. Turning the browser on later

When the rest is stable for a month, set `SUBMISSION_BROWSER_ENABLED=1` and restart:

```sh
docker compose up -d
docker stats --no-stream   # the browser container is capped at 1.5 GB
```

If `api` or `worker` restart under memory pressure, either raise the instance to 8 GB or keep the
browser off. The free 24 GB is why this shape is comfortable.

## 11. Growing past the free tier

- **Stay on Oracle:** adding a paid shape to the same account keeps the instances. It is a resize.
- **Move to Hetzner:** copy `.env`, the volumes and the last backup set, run the same compose file.
- **Add the domain:** buy it, point Cloudflare Tunnel or Caddy at the api port, change
  `PUBLIC_ORIGIN`, and add the new redirect URI in the OAuth client. One env change and one console
  update.
