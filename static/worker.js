self.onmessage = function (e) {
  self.onmessage = null // clean up handler for init eval only
  eval(e.data)
}
