self.onmessage = function (e) {
  self.onmessage = null // clean up
  eval(e.data)
}
