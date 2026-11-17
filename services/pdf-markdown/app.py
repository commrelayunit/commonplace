import base64
import io
import os
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile

_models = None


def get_models():
    global _models
    if _models is None:
        from marker.models import create_model_dict

        _models = create_model_dict()
    return _models


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_models()
    yield


app = FastAPI(lifespan=lifespan)


def encode_image(image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def convert_pdf_bytes(data: bytes) -> dict:
    from marker.converters.pdf import PdfConverter
    from marker.output import text_from_rendered

    temp_file = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    try:
        temp_file.write(data)
        temp_file.close()

        # marker-pdf 2.1.0's equation OCR hard-crashes without a llama-server
        # binary; disabling it trades LaTeX-quality equations for working
        # image extraction (broken in 2.2.0) without that extra dependency.
        converter = PdfConverter(artifact_dict=get_models(), config={"ocr_equations": False})
        rendered = converter(temp_file.name)
        markdown, _, images = text_from_rendered(rendered)

        return {
            "markdown": markdown,
            "images": {name: encode_image(img) for name, img in images.items()},
        }
    finally:
        os.unlink(temp_file.name)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/convert")
def convert(file: UploadFile = File(...)):
    is_pdf = file.content_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf")
    if not is_pdf:
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")
    data = file.file.read()
    try:
        return convert_pdf_bytes(data)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Conversion failed: {error}") from error
