# EXHIBITLY

## Google sign-in setup

Create a Google OAuth 2.0 client with application type **Web application**.

Add these authorized origins and redirect URIs in Google Cloud:

- Origin: `https://exhibitly-vuci.vercel.app`
- Redirect URI: `https://exhibitly-vuci.vercel.app/api/auth/google/callback`
- Local origin: `http://localhost:5173`
- Local redirect URI: `http://localhost:5173/api/auth/google/callback`

Set these environment variables for Production and Preview in Vercel, then redeploy:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://exhibitly-vuci.vercel.app/api/auth/google/callback`

For local development, put the Google client values in `.env`; the local redirect URI is in `.env.example`.

