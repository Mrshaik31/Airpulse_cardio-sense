# ml_inference.py
import os
import io
import numpy as np
from PIL import Image
import librosa
import librosa.display
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision import transforms

# ---------------- Config ----------------
MODEL_PATH = r"C:\Users\akash divate\Desktop\Major Projec Done\final_model.pth"
CLASSES = ["artifact", "extrahls", "extrastole", "murmur", "normal"]

FIGSIZE = (2, 2)
DPI = 100
CMAP = "viridis"
FINAL_IMG_SIZE = (224, 224)
SAMPLE_RATE = 16000
CHUNK_SECONDS = 5

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# ---------------- Model ----------------
class EnhancedHeartCNN(nn.Module):
    def __init__(self, num_classes=5):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
            nn.Conv2d(32, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(),
            nn.MaxPool2d(2), nn.Dropout(0.05),

            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
            nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(),
            nn.MaxPool2d(2), nn.Dropout(0.08),

            nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(),
            nn.Conv2d(128, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(),
            nn.MaxPool2d(2), nn.Dropout(0.12),

            nn.Conv2d(128, 256, 3, padding=1), nn.BatchNorm2d(256), nn.ReLU(),
            nn.Conv2d(256, 256, 3, padding=1), nn.BatchNorm2d(256), nn.ReLU(),
            nn.MaxPool2d(2), nn.Dropout(0.15),

            nn.Conv2d(256, 512, 3, padding=1), nn.BatchNorm2d(512), nn.ReLU(),
            nn.Conv2d(512, 512, 3, padding=1), nn.BatchNorm2d(512), nn.ReLU(),
            nn.MaxPool2d(2), nn.Dropout(0.20),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(512 * 7 * 7, 1024),
            nn.ReLU(),
            nn.Dropout(0.40),
            nn.Linear(1024, 256),
            nn.ReLU(),
            nn.Dropout(0.30),
            nn.Linear(256, num_classes)
        )

    def forward(self, x):
        return self.classifier(self.features(x))


# ---------------- Load Model ----------------
_model = None

def load_model():
    global _model
    if _model is None:
        if not MODEL_PATH or not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(f"Model file not found at: {MODEL_PATH}")
        model = EnhancedHeartCNN(num_classes=len(CLASSES))
        try:
            sd = torch.load(MODEL_PATH, map_location=DEVICE)
        except Exception as e:
            raise RuntimeError(f"Failed to load model from {MODEL_PATH}: {e}")
        model.load_state_dict(sd)
        model.to(DEVICE)
        model.eval()
        _model = model
    return _model


# ---------------- Spectrogram Generation ----------------
test_transform = transforms.Compose([
    transforms.Resize(FINAL_IMG_SIZE),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406],
                         [0.229, 0.224, 0.225])
])


def spectrogram_png_from_audio_chunk(y, sr):
    S = librosa.feature.melspectrogram(
        y=y, sr=sr, n_mels=128, n_fft=2048,
        hop_length=512, fmax=sr // 2
    )
    S_db = librosa.power_to_db(S, ref=np.max)

    fig = plt.figure(figsize=FIGSIZE)
    ax = fig.add_subplot(111)
    librosa.display.specshow(S_db, sr=sr, cmap=CMAP)
    ax.axis("off")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=DPI, bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    buf.seek(0)

    img = Image.open(buf).convert("RGB")
    buf.close()
    return img


def audio_to_png_spectrograms(audio_path):
    y, sr = librosa.load(audio_path, sr=SAMPLE_RATE)
    chunk_length = int(CHUNK_SECONDS * SAMPLE_RATE)

    specs = []
    for start in range(0, len(y), chunk_length):
        chunk = y[start:start + chunk_length]
        if len(chunk) < chunk_length:
            chunk = np.pad(chunk, (0, chunk_length - len(chunk)))
        img = spectrogram_png_from_audio_chunk(chunk, sr)
        specs.append(img)

    return specs


# ---------------- Prediction ----------------
def run_inference(audio_path):
    model = load_model()
    specs = audio_to_png_spectrograms(audio_path)

    all_probs = []
    with torch.no_grad():
        for img in specs:
            inp = test_transform(img).unsqueeze(0).to(DEVICE)
            out = model(inp)
            probs = F.softmax(out, dim=1)[0].cpu().numpy()
            all_probs.append(probs)

    avg = np.mean(all_probs, axis=0)
    idx = int(np.argmax(avg))
    predicted = CLASSES[idx]
    confidence = float(avg[idx])
    decision = "NORMAL" if predicted == "normal" else "ABNORMAL"

    return {
        "decision": decision,
        "predicted_class": predicted,
        "confidence": round(confidence * 100, 2),
        "all_class_probabilities": {CLASSES[i]: float(avg[i]) for i in range(len(CLASSES))}
    }


def get_model_info():
    """Return lightweight metadata about the model and runtime configuration."""
    path = MODEL_PATH
    return {
        "model_path": path,
        "model_exists": os.path.exists(path) if path else False,
        "device": str(DEVICE),
        "num_classes": len(CLASSES),
        "classes": CLASSES,
        "sample_rate": SAMPLE_RATE,
        "chunk_seconds": CHUNK_SECONDS
    }
