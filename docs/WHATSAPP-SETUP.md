# WhatsApp setup (Meta's 2026 "use case" dashboard)

Meta now creates WhatsApp apps from a **use case**, and the WhatsApp Business Account is shown as the **Messaging account**. About 15 minutes.

Put every value into `.env` with a text editor. Never paste them into a chat.

## 1. Create the app

1. Go to https://developers.facebook.com/apps and click **Create App**.
2. Enter the name `KudiLens` and your email.
3. Choose the use case **Connect with customers through WhatsApp**, then click **Next**.
4. Pick your business portfolio, or create one (e.g. `ZCODES`). Click **Next**, then **Create app**.
5. You land on **Customize use case → Connect on WhatsApp → Quickstart**. Click **Start using the API** to open **API Setup**.

## 2. Copy the IDs and a token (API Setup page)

| On the page | Goes into `.env` as |
|---|---|
| **Messaging account**: pick it from the dropdown, or click *Create a WhatsApp Business account*; copy its ID | `WA_WABA_ID` |
| **Generate access token** (temporary, about 24 h) | `WA_TOKEN` |
| **From**: the free test number; copy the *Phone number ID* under it | `WA_PHONE_ID` |
| the test number itself, digits only, e.g. `15551234567` | `WA_DISPLAY_NUMBER` |

**To:** add your own WhatsApp number and confirm it with the code WhatsApp sends you. A test number can talk to at most 5 confirmed numbers. Click **Send message**, and a "hello world" message should arrive on your phone.

## 3. App secret

1. In the left menu, go to **App settings → Basic**.
2. Next to **App secret**, click **Show**, then copy it into `WA_APP_SECRET`.

`WA_VERIFY_TOKEN` is already filled in. You will type the same value into Meta in step 5.

## 4. Give the bot a public HTTPS address

Meta only calls `https://` addresses with a real certificate.

- **Now, from your PC:** open a second terminal and keep it open:
  ```bash
  cd ~/Documents/projects/hackathons/meta-2026/kudilens && npm run tunnel
  ```
  Copy the `https://<random>.trycloudflare.com` address it prints. The address changes every time you restart the tunnel. It exposes only the bot's web server: the passport pages and the signed webhook.
- **Later, on the Oracle server:** `deploy/deploy.sh` gives you `https://<ip-with-dashes>.sslip.io`. Use that as the permanent address.

Restart the bot so it picks up the `WA_*` values, then run:

```bash
npm run wa:check https://<your-address>
```

The check does four things:

- confirms the token, phone ID and app secret all belong to the same app;
- **subscribes the app to the Messaging account** (the step most guides miss: without it, the webhook verifies but real messages never arrive);
- confirms the webhook answers;
- prints ✅ or ❌ with the reason for each check.

## 5. Webhook

1. Go to **Use cases → Customize → Configuration**. Older apps have **WhatsApp → Configuration** instead.
2. Fill in the two fields:
   - **Callback URL**: `https://<your-address>/webhook/whatsapp`
   - **Verify token**: the `WA_VERIFY_TOKEN` value from `.env`
3. Click **Verify and save**.
4. Under **Webhook fields**, subscribe to **messages**.

Send "hi" to the test number from your phone. KudiLens answers with the language picker.

## 6. Permanent token (before the demo and judging)

The step 2 token expires in about a day.

1. Go to https://business.facebook.com/latest/settings and open **System users**.
2. Click **Add**. Choose an Admin role.
3. Click **Assign assets**:
   - your app, with **Manage app** (full control);
   - your WhatsApp account, with **Manage WhatsApp Business accounts** (full control).
4. Click **Generate token**:
   - expiry: **Never**;
   - permissions: `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management`.
5. Replace `WA_TOKEN` with the new token, restart the bot and run `npm run wa:check` again.

## What judges can and cannot do

The test number only talks to the 5 numbers you confirmed. To let anyone message KudiLens on WhatsApp, you need:

- a real phone number added to the Messaging account;
- business verification for the portfolio.

Until then, judges use Telegram (open to everyone), and the demo video shows WhatsApp.
