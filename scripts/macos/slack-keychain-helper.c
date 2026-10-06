// Dedicated legacy-login-Keychain reader. No arbitrary services, writes or shells.
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static const char service[] = "local.pi-chatgpt-bridge.slack.test";
static int valid(const unsigned char *p, UInt32 n, const char *account) {
 const char *prefix = !strcmp(account,"app_token") ? "xapp-" : "xoxb-";
 if(n <= 5 || n > 8192 || memcmp(p,prefix,5)) return 0;
 for(UInt32 i=5;i<n;i++) if(!((p[i]>='A'&&p[i]<='Z')||(p[i]>='a'&&p[i]<='z')||(p[i]>='0'&&p[i]<='9')||p[i]=='-')) return 0;
 return 1;
}
int main(int argc, char **argv) {
 if(argc!=3 || (strcmp(argv[2],"app_token") && strcmp(argv[2],"bot_token"))) return 64;
 int readMode=!strcmp(argv[1],"read"), probe=!strcmp(argv[1],"probe"), approve=!strcmp(argv[1],"authorize"), metadata=!strcmp(argv[1],"metadata");
 if(!readMode&&!probe&&!approve&&!metadata) return 64;
 // Only an explicit local operator authorization command can display a dialog.
 if(SecKeychainSetUserInteractionAllowed(approve)!=errSecSuccess) return 70;
 UInt32 size=0; void *bytes=NULL; SecKeychainItemRef item=NULL;
 OSStatus s=SecKeychainFindGenericPassword(NULL,sizeof(service)-1,service,(UInt32)strlen(argv[2]),argv[2],metadata?NULL:&size,metadata?NULL:&bytes,&item);
 if(metadata) {
  printf("{\"exists\":%s,\"status\":%d",s==errSecSuccess?"true":"false",(int)s);
  SecAccessRef access=NULL; CFArrayRef acls=NULL;
  if(s==errSecSuccess && SecKeychainItemCopyAccess(item,&access)==errSecSuccess && SecAccessCopyACLList(access,&acls)==errSecSuccess) {
   printf(",\"acls\":[");
   for(CFIndex i=0;i<CFArrayGetCount(acls);i++) {
    CFArrayRef apps=NULL; CFStringRef desc=NULL; CSSM_ACL_KEYCHAIN_PROMPT_SELECTOR selector;
    OSStatus a=SecACLCopySimpleContents((SecACLRef)CFArrayGetValueAtIndex(acls,i),&apps,&desc,&selector);
    CSSM_ACL_AUTHORIZATION_TAG tags[128]; UInt32 tagCount=128;
    int decrypt=0;
    if(SecACLGetAuthorizations((SecACLRef)CFArrayGetValueAtIndex(acls,i),tags,&tagCount)==errSecSuccess && tagCount<=128)for(UInt32 j=0;j<tagCount;j++)if(tags[j]==CSSM_ACL_AUTHORIZATION_DECRYPT)decrypt=1;
    printf("%s{\"readable\":%s,\"decrypt_authorization\":%s,\"all_applications\":%s,\"trusted_application_count\":%ld}",i?",":"",a==errSecSuccess?"true":"false",decrypt?"true":"false",a==errSecSuccess&&!apps?"true":"false",apps?(long)CFArrayGetCount(apps):0L);
    if(apps)CFRelease(apps); if(desc)CFRelease(desc);
   } printf("]");
  }
  printf("}\n"); if(acls)CFRelease(acls);if(access)CFRelease(access);if(item)CFRelease(item);return s==errSecSuccess?0:1;
 }
 int ok=s==errSecSuccess && bytes && valid(bytes,size,argv[2]);
 int result=ok?0:1;
 if(readMode && ok) { if(fwrite(bytes,1,size,stdout)!=size || fflush(stdout)) result=74; }
 if(!readMode) printf("{\"readable\":%s,\"token_class_valid\":%s,\"status\":%d}\n",s==errSecSuccess?"true":"false",ok?"true":"false",(int)s);
 if(bytes){volatile unsigned char *wipe=bytes;for(UInt32 i=0;i<size;i++)wipe[i]=0;SecKeychainItemFreeContent(NULL,bytes);}if(item)CFRelease(item);
 return result;
}
