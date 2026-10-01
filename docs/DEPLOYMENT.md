# Deploying to Oracle Cloud (Always Free)

These steps give you an always-on HTTPS server at no cost. Allow about 20 minutes.

## Why not Vercel?

Vercel runs code as short-lived serverless functions. This game needs a process that stays
connected to Twitch chat and pushes live updates to your OBS overlay over WebSockets, which Vercel
does not support. Any small always-on server works; Oracle's free tier is the most generous.

## 1. Create the VM

1. Sign up at <https://www.oracle.com/cloud/free/>.
2. **Compute → Instances → Create instance**.
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere VM.Standard.A1.Flex** (1 OCPU / 6 GB is plenty) or **VM.Standard.E2.1.Micro**.
   - Add your SSH public key.
3. Note the instance's **public IP address**.

## 2. Open ports 80 and 443

Oracle blocks traffic in two places — both must be opened.

**Cloud firewall:** Instance → _Subnet_ → _Security Lists_ → default list → **Add Ingress Rules**:
source `0.0.0.0/0`, TCP, destination ports `80,443`.

**Instance firewall** (Ubuntu images ship with restrictive iptables rules):

```bash
ssh ubuntu@<public-ip>
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 4. Pick a hostname

HTTPS requires a hostname. If you don't have a domain, use the free
[sslip.io](https://sslip.io) wildcard DNS: for IP `203.0.113.7` use `203-0-113-7.sslip.io`.
With your own domain, create an `A` record pointing at the VM's IP.

## 5. Deploy

```bash
git clone https://github.com/kamoras/hues-and-cues-twitch.git
cd hues-and-cues-twitch
cp .env.example .env
nano .env                     # set DOMAIN and ACCESS_CODE (optionally ALLOWED_CHANNELS)
docker compose up -d --build
```

Visit `https://<your-hostname>/control`. Caddy obtains the certificate on the first request
(this can take ~30 seconds).

## Operations

| Task              | Command                                                      |
| ----------------- | ------------------------------------------------------------ |
| View logs         | `docker compose logs -f app`                                 |
| Update            | `git pull && docker compose up -d --build`                   |
| Health            | `curl https://<host>/healthz`                                |
| Back up game data | `docker compose cp app:/data/rooms.json ./rooms-backup.json` |

Rooms and scores live in the `app-data` Docker volume and survive restarts and upgrades.

## Running without Docker

Install Node.js 22, then:

```bash
sudo useradd --system --home /opt/hues-and-cues-twitch hues
sudo git clone https://github.com/kamoras/hues-and-cues-twitch.git /opt/hues-and-cues-twitch
cd /opt/hues-and-cues-twitch && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo cp deploy/hues-and-cues.service /etc/systemd/system/
echo "ACCESS_CODE=change-me" | sudo tee /etc/hues-and-cues.env
sudo systemctl daemon-reload && sudo systemctl enable --now hues-and-cues
```

Put any TLS-terminating reverse proxy (Caddy, nginx) in front and set `TRUST_PROXY=true`.

## OBS setup

1. In the control panel, copy the **overlay URL**.
2. OBS → _Sources_ → **+** → _Browser_. Paste the URL; set width **1920** and height **1080**.
3. Leave _Custom CSS_ as default — the overlay background is already transparent.
4. Optionally enable _Refresh browser when scene becomes active_.
