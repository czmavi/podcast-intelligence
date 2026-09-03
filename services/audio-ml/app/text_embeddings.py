from threading import Lock

from .config import Settings
from .errors import MlServiceError


class TextEmbedder:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None
        self._lock = Lock()

    def load(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is None:
                try:
                    from sentence_transformers import SentenceTransformer

                    self._model = SentenceTransformer(self.settings.text_embedding_model)
                except Exception as exc:
                    raise MlServiceError(
                        "MODEL_NOT_AVAILABLE",
                        f"Text embedding model nelze načíst: {type(exc).__name__}",
                        status_code=503,
                    ) from exc
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self.load().encode(
            texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False
        )
        return vectors.astype(float).tolist()


class TextReranker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None
        self._lock = Lock()

    def load(self):
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is None:
                try:
                    from sentence_transformers import CrossEncoder

                    self._model = CrossEncoder(
                        self.settings.text_reranker_model,
                        device=(
                            None
                            if self.settings.model_device == "auto"
                            else self.settings.model_device
                        ),
                    )
                except Exception as exc:
                    raise MlServiceError(
                        "MODEL_NOT_AVAILABLE",
                        f"Text reranker nelze načíst: {type(exc).__name__}",
                        status_code=503,
                    ) from exc
        return self._model

    def rerank(self, query: str, documents: list[str]) -> list[float]:
        import torch

        pairs = [(query, document) for document in documents]
        scores = self.load().predict(
            pairs,
            batch_size=8,
            activation_fn=torch.nn.Sigmoid(),
            show_progress_bar=False,
        )
        return [float(score) for score in scores]
