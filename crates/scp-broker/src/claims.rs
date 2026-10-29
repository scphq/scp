use serde_json::{Map, Value};

use crate::core::Core;
use crate::proto::RpcError;
use crate::state::ConnectionId;

pub async fn hello_claim(
    _core: &mut Core,
    _conn: ConnectionId,
    _params: &Map<String, Value>,
) -> Result<Value, RpcError> {
    Err(RpcError::invalid_params("an agent claim is not available"))
}
