# ===================================================
#  Bank Server (receiver) - FastAPI
#  Serves the ATM page and verifies the CRC of each codeword
# ===================================================

from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent

# The bank's own generator polynomial: x^6 + x^2 + x + 1
GENERATOR = "1000111"
CRC_BITS = len(GENERATOR) - 1   # 6

app = FastAPI(title="Bank Server - CRC Verifier")


# ---------- What the ATM sends us ----------
class VerifyRequest(BaseModel):
    transaction_id: str
    transaction_type: str
    codeword: str
    generator: str


# ---------- CRC division (modulo-2) ----------
def crc_divide(bits: str, generator: str):
    """Divides the bits by the generator. Returns (remainder, steps)."""
    arr = [int(b) for b in bits]
    gen = [int(b) for b in generator]
    glen = len(gen)

    steps = []
    xor_count = 0

    for i in range(len(arr) - glen + 1):
        if arr[i] == 1:
            before = "".join(str(b) for b in arr[i:i + glen])
            for j in range(glen):
                arr[i + j] ^= gen[j]          # XOR = modulo-2 subtraction
            after = "".join(str(b) for b in arr[i:i + glen])
            xor_count += 1

            # Keep only the first 5 steps for display (the full list is very long)
            if xor_count <= 5:
                steps.append(
                    f"Step {xor_count} (at bit {i + 1}): {before} XOR {generator} = {after}"
                )

    remainder = "".join(str(b) for b in arr[-(glen - 1):])

    if xor_count > 5:
        steps.append(f"... {xor_count - 5} more XOR steps ...")
    steps.append(f"Total XOR steps: {xor_count}")
    steps.append(f"Final remainder: {remainder}")

    return remainder, steps


# ---------- The bank server's main job ----------
@app.post("/verify")
def verify(req: VerifyRequest):
    codeword = req.codeword.strip()

    # Basic check: only 0s and 1s, and long enough to contain a CRC
    if len(codeword) <= CRC_BITS or set(codeword) - {"0", "1"}:
        raise HTTPException(status_code=400, detail="Codeword must be a string of 0s and 1s.")

    # The server uses ITS OWN generator, not the one the page claims
    remainder, steps = crc_divide(codeword, GENERATOR)
    no_error = remainder == "0" * CRC_BITS

    return {
        "transaction_id": req.transaction_id,
        "transaction_type": req.transaction_type,
        "received_codeword": codeword,
        "generator": GENERATOR,
        "remainder": remainder,
        "crc_status": "NO_ERROR" if no_error else "ERROR_DETECTED",
        "transaction_status": "ACCEPTED" if no_error else "REJECTED",
        "division_steps": steps,
    }


# ---------- Accuracy test: many codewords in one request ----------
MAX_BATCH = 5000


class BatchItem(BaseModel):
    id: int
    codeword: str


class BatchRequest(BaseModel):
    generator: str            # sent by the page, but the bank uses its own
    items: List[BatchItem]


@app.post("/verify_batch")
def verify_batch(req: BatchRequest):
    if len(req.items) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"At most {MAX_BATCH} codewords per request.")

    results = []
    for item in req.items:
        codeword = item.codeword.strip()
        if len(codeword) <= CRC_BITS or set(codeword) - {"0", "1"}:
            raise HTTPException(status_code=400, detail=f"Codeword {item.id} must be a string of 0s and 1s.")

        # Same division as /verify, using the bank's own generator
        remainder, _ = crc_divide(codeword, GENERATOR)
        results.append({"id": item.id, "detected": remainder != "0" * CRC_BITS})

    return {"results": results}


# ---------- Serving the ATM page ----------
@app.get("/")
def home():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/script.js")
def script():
    return FileResponse(BASE_DIR / "script.js", media_type="application/javascript")


@app.get("/style.css")
def style():
    return FileResponse(BASE_DIR / "style.css", media_type="text/css")