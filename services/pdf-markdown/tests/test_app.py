# services/pdf-markdown/tests/test_app.py
from fastapi.testclient import TestClient
from app import app

def test_health_returns_ok():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


import base64
import io

from PIL import Image

from app import encode_image

PDF_BYTES = b"%PDF-1.4\n%fake-but-well-formed-enough-for-tests"


def test_convert_rejects_non_pdf_content():
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("notes.txt", b"hello", "text/plain")})
    assert response.status_code == 400


def test_convert_returns_markdown_and_images(monkeypatch):
    fixture = {"markdown": "# Fixture\n\nHello.", "images": {"fig1.png": "aGVsbG8="}}
    monkeypatch.setattr("app.convert_pdf_bytes", lambda data: fixture)
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("doc.pdf", PDF_BYTES, "application/pdf")})
    assert response.status_code == 200
    assert response.json() == fixture


def test_convert_surfaces_conversion_failures(monkeypatch):
    def boom(data):
        raise RuntimeError("marker blew up")

    monkeypatch.setattr("app.convert_pdf_bytes", boom)
    client = TestClient(app)
    response = client.post("/convert", files={"file": ("doc.pdf", PDF_BYTES, "application/pdf")})
    assert response.status_code == 502


def test_encode_image_returns_base64_png():
    image = Image.new("RGB", (1, 1))
    encoded = encode_image(image)
    decoded = base64.b64decode(encoded)
    assert decoded.startswith(b"\x89PNG")
