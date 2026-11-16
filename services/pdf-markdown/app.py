import base64
import io
import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile

app = FastAPI()

_models = None


def get_models():
    global _models
    if _models is None:
        from marker.models import create_model_dict

        _models = create_model_dict()
    return _models


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

        converter = PdfConverter(artifact_dict=get_models())
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
async def convert(file: UploadFile = File(...)):
    is_pdf = file.content_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf")
    if not is_pdf:
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")
    data = await file.read()
    try:
        return convert_pdf_bytes(data)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Conversion failed: {error}") from error
