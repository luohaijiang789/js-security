// Static-analysis driver only. Never import/execute against a real website.
import {request} from './console-ui/src/globalLib.js';
request({url:'v3/console/ns/service/list?ignoreEmptyService=false&withInstances=false&pageNo=1&pageSize=10&serviceNameParam=demo&groupNameParam=DEFAULT_GROUP',type:'GET'});
