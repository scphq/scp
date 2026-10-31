//! Wake settlement seam: the wake worker owns the real bodies.

use crate::core::Core;
use crate::proto::RpcError;

impl Core {
    pub async fn settle_revived(
        &mut self,
        _now: i64,
        _endpoint: Option<&str>,
    ) -> Result<(), RpcError> {
        Ok(())
    }

    pub async fn lapse_wake(&mut self, _endpoint: &str, _now: i64) -> Result<(), RpcError> {
        Ok(())
    }
}
