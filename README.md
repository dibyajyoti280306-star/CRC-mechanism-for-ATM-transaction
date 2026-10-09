# ATM Transaction Integrity Using CRC

Web application with an HTML/CSS/JavaScript frontend and a FastAPI backend.

## Run locally

1. Install Python 3.10 or newer.
2. Open a terminal in this folder.
3. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

4. Start the server:

   ```bash
   uvicorn app:app --reload
   ```

5. Open http://127.0.0.1:8000

## Deploy to Render

This repository includes `render.yaml`. Push the project to GitHub, then in Render
choose **New + → Blueprint** and select the repository. Render will read the
configuration and deploy the web service. Alternatively, create a **Web Service**
with build command `pip install -r requirements.txt` and start command
`uvicorn app:app --host 0.0.0.0 --port $PORT`.

The frontend calls `/verify` and `/verify_batch` on the same origin, so it does not
need a hard-coded localhost URL in production.
