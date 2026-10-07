#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
// Dedicated service, opaque UUID account, bounded secret on stdin; no raw argv.
int main(int argc,char **argv){
 if(argc!=3||strlen(argv[2])!=36)return 64;
 for(int i=0;i<36;i++)if(!((argv[2][i]>='0'&&argv[2][i]<='9')||(argv[2][i]>='a'&&argv[2][i]<='f')||argv[2][i]=='-'))return 64;
 const char *revocations="io.airodrom.operator.vault.revocation.v1";
 SecKeychainSetUserInteractionAllowed(false);
 OSStatus revoked=SecKeychainFindGenericPassword(NULL,(UInt32)strlen(revocations),revocations,36,argv[2],NULL,NULL,NULL);
 if(!strcmp(argv[1],"revoke")){if(revoked==errSecSuccess)return 0;return SecKeychainAddGenericPassword(NULL,(UInt32)strlen(revocations),revocations,36,argv[2],7,"revoked",NULL)==errSecSuccess?0:1;}
 if(strcmp(argv[1],"delete")&&revoked!=errSecItemNotFound)return 1;
 const char *service="io.airodrom.operator.vault.v1";const char *account=argv[2];SecKeychainItemRef item=NULL;UInt32 n=0;void *bytes=NULL;
 SecKeychainSetUserInteractionAllowed(false);
 OSStatus s=SecKeychainFindGenericPassword(NULL,(UInt32)strlen(service),service,36,account,&n,&bytes,&item);
 int result=1;
 if(!strcmp(argv[1],"read")){if(s==errSecSuccess&&n<=8192&&fwrite(bytes,1,n,stdout)==n)result=0;}
 else if(!strcmp(argv[1],"delete")){if(s==errSecItemNotFound||(s==errSecSuccess&&SecKeychainItemDelete(item)==errSecSuccess))result=0;}
 else if(!strcmp(argv[1],"put")){
  unsigned char buffer[8193];size_t count=fread(buffer,1,sizeof(buffer),stdin);
  if(count>0&&count<=8192&&s==errSecItemNotFound&&SecKeychainAddGenericPassword(NULL,(UInt32)strlen(service),service,36,account,(UInt32)count,buffer,NULL)==errSecSuccess)result=0;
  volatile unsigned char *wipe=buffer;for(size_t i=0;i<sizeof(buffer);i++)wipe[i]=0;
 }
 if(bytes){volatile unsigned char *wipe=bytes;for(UInt32 i=0;i<n;i++)wipe[i]=0;SecKeychainItemFreeContent(NULL,bytes);}if(item)CFRelease(item);return result;
}
