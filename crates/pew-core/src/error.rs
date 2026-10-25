use thiserror::Error;

#[derive(Error, Debug)]
pub enum PewError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("Server returned unexpected status: {0}")]
    HttpStatus(reqwest::StatusCode),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("{0}")]
    Custom(String),
}

pub type Result<T> = std::result::Result<T, PewError>;
