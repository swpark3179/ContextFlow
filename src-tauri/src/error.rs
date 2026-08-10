use serde::Serialize;

/// Every command returns this. `kind` lets the UI branch (e.g. show the
/// "복사로 가져오기" hint when a symlink fails for lack of privilege) instead of
/// only surfacing a message string.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: String,
    pub message: String,
}

impl AppError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into() }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new("io", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let kind = match e.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::AlreadyExists => "already_exists",
            _ => "io",
        };
        Self::new(kind, e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("json", e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
