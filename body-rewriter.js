match:        ^https?://api\.example\.com/
contentType:  application/json
mode:         json
transform:
  return { ...data, __ghost: 'touched' };