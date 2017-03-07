# Global





* * *

## Class: Security
Create a wrapper to the security functionality of the underlying BLE driver.


## Class: Security
Create a wrapper to the security functionality of the underlying BLE driver.

### Security.generateKeyPair() 

Method that generates a public/private key pair where the public key is to be distributed.

**Returns**: `Object`, The public private key pair. TODO: double check this.

### Security.generatePublicKey(privateKey) 

Method that generates a public key.

**Parameters**

**privateKey**: `string`, The private key that should be used to generate the public key.

**Returns**: `string`, The generated public key.

### Security.generateSharedSecret(privateKey, publicKey) 

Method that generates a shared secret.

**Parameters**

**privateKey**: `string`, The private key that should be used to generate the shared secret.

**publicKey**: `string`, The public key that should be used to generate the shared secret.

**Returns**: `string`, The generated shared secret.



* * *










